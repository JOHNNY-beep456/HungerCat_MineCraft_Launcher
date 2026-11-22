//! 五种 AI provider 的纯协议 codec。
//!
//! 本模块只负责 native JSON 的编码与解码：不联网、不读写文件、不访问 Storage，
//! 也不执行工具或等待审批。工具执行结果交给上层编排器；模型返回的 assistant
//! 消息会原样保留必要字段（包括 provider 的 opaque/thoughtSignature 字段）。
use crate::ai_tool_runtime::{validate_intent, ToolExecution, ToolIntent};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MAX_CALLS: usize = 16;
const MAX_MODEL_CHARS: usize = 256;
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// 一轮 provider 响应的统一表示。`assistant` 是可直接追加到下一轮 conversation 的
/// native assistant/model message，不是把工具调用压成文本的摘要。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderTurn {
    pub(crate) text: String,
    pub(crate) tool_calls: Vec<ToolIntent>,
    pub(crate) assistant: Value,
}

fn format_name(format: &str) -> Result<&str, String> {
    match format {
        "openai" | "custom" | "anthropic" | "gemini" | "ollama" => Ok(format),
        _ => Err("未知 AI 接口格式".into()),
    }
}

fn checked_model(model: &str) -> Result<(), String> {
    if model.trim().is_empty() || model.chars().count() > MAX_MODEL_CHARS || model.chars().any(char::is_control) {
        return Err("模型 ID 无效".into());
    }
    Ok(())
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value.as_object().ok_or_else(|| format!("{what}必须是 JSON 对象"))
}

fn array<'a>(value: &'a Value, what: &str) -> Result<&'a Vec<Value>, String> {
    value.as_array().ok_or_else(|| format!("{what}必须是 JSON 数组"))
}

fn string_field<'a>(value: &'a Value, key: &str, what: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str).filter(|text| !text.trim().is_empty() && !text.chars().any(char::is_control)).ok_or_else(|| format!("{what}缺少有效的 {key}"))
}

fn bounded_json(value: &Value, what: &str) -> Result<(), String> {
    if serde_json::to_vec(value).map_err(|_| format!("{what}无法编码"))?.len() > MAX_JSON_BYTES {
        return Err(format!("{what}过大"));
    }
    Ok(())
}

fn bounded_text(text: &str, what: &str) -> Result<(), String> {
    if text.len() > MAX_TEXT_BYTES || text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Err(format!("{what}无效或过大"));
    }
    Ok(())
}

fn copy_conversation(format: &str, conversation: &[Value]) -> Result<Vec<Value>, String> {
    if conversation.len() > 128 { return Err("对话消息过多".into()); }
    let mut out = Vec::with_capacity(conversation.len());
    for message in conversation {
        bounded_json(message, "对话消息")?;
        let map = object(message, "对话消息")?;
        let role = string_field(message, "role", "对话消息")?;
        match format {
            "openai" | "custom" | "ollama" => {
                if !matches!(role, "user" | "assistant" | "tool" | "system") { return Err("OpenAI/Ollama 消息 role 无效".into()); }
            }
            "anthropic" => {
                if !matches!(role, "user" | "assistant") { return Err("Anthropic 对话不允许该 role".into()); }
            }
            "gemini" => {
                if !matches!(role, "user" | "model") { return Err("Gemini 对话 role 无效".into()); }
                let parts = map.get("parts").ok_or("Gemini 对话缺少 parts")?;
                if !parts.is_array() { return Err("Gemini parts 必须是数组".into()); }
            }
            _ => unreachable!(),
        }
        out.push(message.clone());
    }
    Ok(out)
}

fn spec_fields(spec: &Value) -> Result<(&str, &str, Value), String> {
    let name = string_field(spec, "name", "工具声明")?;
    let description = string_field(spec, "description", "工具声明")?;
    let schema = spec.get("inputSchema").ok_or("工具声明缺少 inputSchema")?.clone();
    object(&schema, "工具 inputSchema")?;
    bounded_json(&schema, "工具 inputSchema")?;
    Ok((name, description, schema))
}

fn openai_tools(specs: &[Value]) -> Result<Vec<Value>, String> {
    if specs.len() > 64 { return Err("工具声明过多".into()); }
    specs.iter().map(|spec| {
        let (name, description, schema) = spec_fields(spec)?;
        Ok(json!({"type":"function","function":{"name":name,"description":description,"parameters":schema}}))
    }).collect()
}

fn anthropic_tools(specs: &[Value]) -> Result<Vec<Value>, String> {
    if specs.len() > 64 { return Err("工具声明过多".into()); }
    specs.iter().map(|spec| {
        let (name, description, schema) = spec_fields(spec)?;
        Ok(json!({"name":name,"description":description,"input_schema":schema}))
    }).collect()
}

fn gemini_tools(specs: &[Value]) -> Result<Vec<Value>, String> {
    if specs.len() > 64 { return Err("工具声明过多".into()); }
    let mut declarations = Vec::with_capacity(specs.len());
    for spec in specs {
        let (name, description, schema) = spec_fields(spec)?;
        declarations.push(json!({"name":name,"description":description,"parameters":schema}));
    }
    Ok(vec![json!({"functionDeclarations":declarations})])
}

/// 构造一次 native provider 请求体。`conversation` 已由调用方按 provider 规范生成。
/// 本函数只加入 system/config/tools，不插入用户消息，也不把历史转成字符串。
pub(crate) fn request_body(format: &str, model: &str, system: &str, conversation: &[Value], specs: &[Value]) -> Result<Value, String> {
    let format = format_name(format)?;
    checked_model(model)?;
    bounded_text(system, "system 提示")?;
    let conversation = copy_conversation(format, conversation)?;
    let system = system.trim();
    match format {
        "openai" | "custom" => {
            let mut messages = Vec::with_capacity(conversation.len() + if system.is_empty() { 0 } else { 1 });
            if !system.is_empty() { messages.push(json!({"role":"system","content":system})); }
            messages.extend(conversation);
            let mut body = json!({"model":model,"messages":messages,"temperature":0.3,"stream":false});
            if !specs.is_empty() { body["tools"] = Value::Array(openai_tools(specs)?); body["tool_choice"] = json!("auto"); }
            bounded_json(&body, "请求体")?;
            Ok(body)
        }
        "anthropic" => {
            let mut body = json!({"model":model,"max_tokens":2048,"temperature":0.3,"messages":conversation});
            if !system.is_empty() { body["system"] = json!(system); }
            if !specs.is_empty() { body["tools"] = Value::Array(anthropic_tools(specs)?); }
            bounded_json(&body, "请求体")?;
            Ok(body)
        }
        "gemini" => {
            let mut body = json!({"contents":conversation,"generationConfig":{"temperature":0.3}});
            if !system.is_empty() { body["systemInstruction"] = json!({"parts":[{"text":system}]}); }
            if !specs.is_empty() { body["tools"] = Value::Array(gemini_tools(specs)?); }
            bounded_json(&body, "请求体")?;
            Ok(body)
        }
        "ollama" => {
            let mut messages = Vec::with_capacity(conversation.len() + if system.is_empty() { 0 } else { 1 });
            if !system.is_empty() { messages.push(json!({"role":"system","content":system})); }
            messages.extend(conversation);
            let mut body = json!({"model":model,"messages":messages,"stream":false,"options":{"temperature":0.3}});
            if !specs.is_empty() { body["tools"] = Value::Array(openai_tools(specs)?); }
            bounded_json(&body, "请求体")?;
            Ok(body)
        }
        _ => unreachable!(),
    }
}

fn stable_id(prefix: &str, index: usize, name: &str, args: &Value) -> String {
    // Gemini/Ollama 响应有时没有 call id。用本轮响应内容生成稳定 UUID 形状，
    // 同一响应重试解析不会改变绑定；调用方仍把它视为不可信 provider id。
    let mut hash = Sha256::new();
    hash.update(prefix.as_bytes());
    hash.update([0]);
    hash.update(index.to_le_bytes());
    hash.update([0]);
    hash.update(name.as_bytes());
    hash.update([0]);
    hash.update(serde_json::to_vec(args).unwrap_or_default());
    let bytes = hash.finalize();
    let mut b = [0u8; 16];
    b.copy_from_slice(&bytes[..16]);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15])
}

fn call_args(value: Option<&Value>, what: &str) -> Result<Value, String> {
    let value = value.ok_or_else(|| format!("{what}缺少 arguments/input"))?;
    let parsed = if let Some(text) = value.as_str() {
        serde_json::from_str::<Value>(text).map_err(|_| format!("{what} arguments 不是有效 JSON"))?
    } else { value.clone() };
    if !parsed.is_object() { return Err(format!("{what} arguments 必须是 JSON 对象")); }
    bounded_json(&parsed, "工具参数")?;
    Ok(parsed)
}

fn call_id(id: &str, what: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control) { return Err(format!("{what} 缺少有效 id")); }
    Ok(())
}

fn append_call(calls: &mut Vec<ToolIntent>, ids: &mut HashSet<String>, id: String, name: &str, args: Value) -> Result<(), String> {
    call_id(&id, "工具调用")?;
    if !ids.insert(id.clone()) { return Err("provider 返回重复的工具调用 id".into()); }
    if calls.len() >= MAX_CALLS { return Err("模型一次请求的工具调用超过上限".into()); }
    calls.push(validate_intent(&id, name, &args)?);
    Ok(())
}

fn text_from_openai_content(content: Option<&Value>) -> Result<String, String> {
    let Some(content) = content else { return Ok(String::new()) };
    if content.is_null() { return Ok(String::new()); }
    if let Some(text) = content.as_str() { bounded_text(text, "模型正文")?; return Ok(text.to_owned()); }
    let parts = content.as_array().ok_or("OpenAI content 格式无效")?;
    let mut text = String::new();
    for part in parts {
        let map = object(part, "OpenAI content part")?;
        if let Some(value) = map.get("text") { text.push_str(value.as_str().ok_or("OpenAI content part 的 text 无效")?); }
    }
    bounded_text(&text, "模型正文")?;
    Ok(text)
}

fn parse_openai(format: &str, response: &Value) -> Result<ProviderTurn, String> {
    let choices = array(response.get("choices").ok_or("OpenAI 响应缺少 choices")?, "choices")?;
    let first = choices.first().ok_or("OpenAI 响应缺少候选结果")?;
    let message_value = first.get("message").ok_or("OpenAI 响应缺少 message")?;
    let original = object(message_value, "OpenAI message")?;
    let mut assistant = message_value.clone();
    let assistant_map = assistant.as_object_mut().expect("刚刚已验证 message object");
    if let Some(role) = assistant_map.get("role") { if role.as_str() != Some("assistant") { return Err("OpenAI assistant role 无效".into()); } }
    else { assistant_map.insert("role".into(), json!("assistant")); }
    let text = text_from_openai_content(original.get("content"))?;
    let calls = match original.get("tool_calls") { None | Some(Value::Null) => Vec::new(), Some(value) => array(value, "tool_calls")?.to_vec() };
    if calls.len() > MAX_CALLS { return Err("工具调用超过上限".into()); }
    let mut out = Vec::with_capacity(calls.len());
    let mut ids = HashSet::new();
    for call in calls {
        let map = object(&call, "OpenAI tool call")?;
        let id = string_field(&call, "id", "OpenAI tool call")?.to_owned();
        let function = map.get("function").ok_or("OpenAI tool call 缺少 function")?;
        let name = string_field(function, "name", "OpenAI function")?;
        let args = call_args(object(function, "OpenAI function").ok().and_then(|m| m.get("arguments")), "OpenAI function")?;
        append_call(&mut out, &mut ids, id, name, args)?;
    }
    if text.trim().is_empty() && out.is_empty() { return Err("模型返回空正文且没有工具调用".into()); }
    let _ = format;
    Ok(ProviderTurn { text: text.trim().to_owned(), tool_calls: out, assistant })
}

fn parse_anthropic(response: &Value) -> Result<ProviderTurn, String> {
    let blocks = array(response.get("content").ok_or("Anthropic 响应缺少 content")?, "Anthropic content")?;
    if blocks.len() > MAX_CALLS + 64 { return Err("Anthropic content 过多".into()); }
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut ids = HashSet::new();
    for block in blocks {
        let map = object(block, "Anthropic content block")?;
        match map.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(string_field(block, "text", "Anthropic text")?),
            Some("tool_use") => {
                let id = string_field(block, "id", "Anthropic tool_use")?.to_owned();
                let name = string_field(block, "name", "Anthropic tool_use")?;
                let args = call_args(map.get("input"), "Anthropic tool_use")?;
                append_call(&mut calls, &mut ids, id, name, args)?;
            }
            Some(_) => { /* 保留未知 opaque block，不擅自丢弃 */ }
            None => return Err("Anthropic content block 缺少 type".into()),
        }
    }
    bounded_text(&text, "模型正文")?;
    if text.trim().is_empty() && calls.is_empty() { return Err("模型返回空正文且没有工具调用".into()); }
    Ok(ProviderTurn { text: text.trim().to_owned(), tool_calls: calls, assistant: json!({"role":"assistant","content":blocks}) })
}

fn parse_gemini(response: &Value) -> Result<ProviderTurn, String> {
    let candidates = array(response.get("candidates").ok_or("Gemini 响应缺少 candidates")?, "candidates")?;
    let candidate = candidates.first().ok_or("Gemini 响应缺少候选结果")?;
    let content = object(candidate.get("content").ok_or("Gemini 候选缺少 content")?, "Gemini content")?;
    let parts = array(content.get("parts").ok_or("Gemini content 缺少 parts")?, "Gemini parts")?;
    if parts.len() > MAX_CALLS + 64 { return Err("Gemini parts 过多".into()); }
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut ids = HashSet::new();
    for (index, part) in parts.iter().enumerate() {
        let map = object(part, "Gemini part")?;
        if let Some(value) = map.get("text") { text.push_str(value.as_str().ok_or("Gemini text 无效")?); }
        if let Some(function_call) = map.get("functionCall") {
            let fc = object(function_call, "Gemini functionCall")?;
            let name = string_field(function_call, "name", "Gemini functionCall")?;
            let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
            if !args.is_object() { return Err("Gemini functionCall args 必须是 JSON 对象".into()); }
            let id = stable_id("gemini", index, name, &args);
            append_call(&mut calls, &mut ids, id, name, args)?;
        }
    }
    bounded_text(&text, "模型正文")?;
    if text.trim().is_empty() && calls.is_empty() { return Err("模型返回空正文且没有工具调用".into()); }
    Ok(ProviderTurn { text: text.trim().to_owned(), tool_calls: calls, assistant: json!({"role":"model","parts":parts}) })
}

fn parse_ollama(response: &Value) -> Result<ProviderTurn, String> {
    let message = response.get("message").ok_or("Ollama 响应缺少 message")?;
    let map = object(message, "Ollama message")?;
    let mut assistant = message.clone();
    let assistant_map = assistant.as_object_mut().expect("刚刚已验证 message object");
    if let Some(role) = assistant_map.get("role") { if role.as_str() != Some("assistant") { return Err("Ollama assistant role 无效".into()); } }
    else { assistant_map.insert("role".into(), json!("assistant")); }
    let text = map.get("content").map(|v| v.as_str().ok_or("Ollama content 无效")).transpose()?.unwrap_or("").to_owned();
    let calls = match map.get("tool_calls") { None | Some(Value::Null) => Vec::new(), Some(value) => array(value, "Ollama tool_calls")?.to_vec() };
    if calls.len() > MAX_CALLS { return Err("工具调用超过上限".into()); }
    let mut out = Vec::new();
    let mut ids = HashSet::new();
    for (index, call) in calls.iter().enumerate() {
        let call_map = object(call, "Ollama tool call")?;
        let function = call_map.get("function").ok_or("Ollama tool call 缺少 function")?;
        let function_map = object(function, "Ollama function")?;
        let name = string_field(function, "name", "Ollama function")?;
        let args = call_args(function_map.get("arguments"), "Ollama function")?;
        let id = call_map.get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty()).map(ToOwned::to_owned).unwrap_or_else(|| stable_id("ollama", index, name, &args));
        append_call(&mut out, &mut ids, id, name, args)?;
    }
    bounded_text(&text, "模型正文")?;
    if text.trim().is_empty() && out.is_empty() { return Err("模型返回空正文且没有工具调用".into()); }
    Ok(ProviderTurn { text: text.trim().to_owned(), tool_calls: out, assistant })
}

/// 解析 provider 响应；所有工具调用均通过冻结的 strict `validate_intent`。
pub(crate) fn parse_turn(format: &str, response: &Value) -> Result<ProviderTurn, String> {
    let format = format_name(format)?;
    bounded_json(response, "模型响应")?;
    match format {
        "openai" | "custom" => parse_openai(format, response),
        "anthropic" => parse_anthropic(response),
        "gemini" => parse_gemini(response),
        "ollama" => parse_ollama(response),
        _ => unreachable!(),
    }
}

fn checked_results(format: &str, intents: &[ToolIntent], results: &[ToolExecution]) -> Result<(), String> {
    format_name(format)?;
    if intents.len() != results.len() { return Err("工具调用与结果数量不匹配".into()); }
    if intents.len() > MAX_CALLS { return Err("工具调用超过上限".into()); }
    let mut ids = HashSet::new();
    for (intent, result) in intents.iter().zip(results.iter()) {
        let normalized = validate_intent(&intent.provider_call_id, &intent.name, &intent.args)?;
        if normalized != *intent { return Err("工具调用未经过规范化校验".into()); }
        call_id(&intent.provider_call_id, "工具调用")?;
        if !ids.insert(intent.provider_call_id.clone()) { return Err("工具结果存在重复 call id".into()); }
        bounded_text(&result.text, "工具结果")?;
    }
    Ok(())
}

/// 将已配对的工具结果编码为下一轮的 native message。调用方必须先按原顺序传入
/// `intents/results`；本函数不会猜测、排序或把结果送入错误的 tool call。
pub(crate) fn tool_results(format: &str, intents: &[ToolIntent], results: &[ToolExecution]) -> Result<Vec<Value>, String> {
    let format = format_name(format)?;
    checked_results(format, intents, results)?;
    match format {
        "openai" | "custom" => Ok(intents.iter().zip(results).map(|(intent, result)| json!({"role":"tool","tool_call_id":intent.provider_call_id,"name":intent.name,"content":result.text})).collect()),
        "ollama" => Ok(intents.iter().zip(results).map(|(intent, result)| json!({"role":"tool","tool_name":intent.name,"content":result.text})).collect()),
        "anthropic" => Ok(vec![json!({"role":"user","content":intents.iter().zip(results).map(|(intent,result)| json!({"type":"tool_result","tool_use_id":intent.provider_call_id,"content":result.text,"is_error":!result.ok})).collect::<Vec<_>>()})]),
        "gemini" => Ok(vec![json!({"role":"user","parts":intents.iter().zip(results).map(|(intent,result)| json!({"functionResponse":{"name":intent.name,"response":{"ok":result.ok,"text":result.text,"callId":intent.provider_call_id}}})).collect::<Vec<_>>()})]),
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_tool_runtime::specs_value;

    fn specs() -> Vec<Value> { specs_value().as_array().cloned().unwrap_or_default() }
    fn intent(name: &str, args: Value) -> ToolIntent { validate_intent("call-1", name, &args).unwrap() }

    #[test]
    fn request_bodies_use_native_system_tools_and_history() {
        let conversation = vec![json!({"role":"user","content":"hello"}), json!({"role":"assistant","content":"history"})];
        for format in ["openai", "custom", "ollama"] {
            let body = request_body(format, "model", "system", &conversation, &specs()).unwrap();
            assert_eq!(body["messages"][0], json!({"role":"system","content":"system"}));
            assert_eq!(body["messages"][1], conversation[0]);
            assert!(body["tools"].is_array());
            assert_eq!(body["stream"], false);
        }
        let anthropic = request_body("anthropic", "claude", "system", &conversation, &specs()).unwrap();
        assert_eq!(anthropic["system"], "system");
        assert_eq!(anthropic["messages"], Value::Array(conversation.clone()));
        assert_eq!(anthropic["tools"][0]["input_schema"], specs()[0]["inputSchema"]);
        let gemini_conversation = vec![json!({"role":"user","parts":[{"text":"hello"}]}), json!({"role":"model","parts":[{"text":"history"}]})];
        let gemini = request_body("gemini", "gem", "system", &gemini_conversation, &specs()).unwrap();
        assert_eq!(gemini["contents"], Value::Array(gemini_conversation.clone()));
        assert_eq!(gemini["systemInstruction"]["parts"][0]["text"], "system");
        assert!(request_body("bad", "model", "", &[], &[]).is_err());
        assert!(request_body("openai", "", "", &[], &[]).is_err());
    }

    #[test]
    fn openai_custom_and_ollama_roundtrip_preserve_assistant_native_fields() {
        let response = json!({"choices":[{"message":{"role":"assistant","content":"请确认","reasoning_content":"opaque","tool_calls":[{"id":"call-1","type":"function","function":{"name":"launcher_delete_version","arguments":"{\"versionId\":\"1.20.1\"}"}}]}}]});
        for format in ["openai", "custom"] {
            let turn = parse_turn(format, &response).unwrap();
            assert_eq!(turn.text, "请确认");
            assert_eq!(turn.tool_calls.len(), 1);
            assert_eq!(turn.assistant["reasoning_content"], "opaque");
            let messages = tool_results(format, &turn.tool_calls, &[ToolExecution::success("已完成")]).unwrap();
            assert_eq!(messages[0], json!({"role":"tool","tool_call_id":"call-1","name":"launcher_delete_version","content":"已完成"}));
        }
        let ollama_response = json!({"message":{"role":"assistant","content":"","opaque_meta":{"x":1},"tool_calls":[{"function":{"name":"launcher_delete_version","arguments":{"versionId":"1.20.1"}}}]}});
        let turn = parse_turn("ollama", &ollama_response).unwrap();
        assert_eq!(turn.assistant["opaque_meta"]["x"], 1);
        assert_eq!(turn.tool_calls[0].name, "launcher_delete_version");
        assert_eq!(tool_results("ollama", &turn.tool_calls, &[ToolExecution::failure("拒绝")]).unwrap(), vec![json!({"role":"tool","tool_name":"launcher_delete_version","content":"拒绝"})]);
        let two = json!({"message":{"role":"assistant","content":"多行\n正文","tool_calls":[{"id":"a","function":{"name":"launcher_delete_version","arguments":{"versionId":"one"}}},{"id":"b","function":{"name":"launcher_rename_version","arguments":{"versionId":"old","newName":"new"}}}]}});
        let two_turn = parse_turn("ollama", &two).unwrap();
        assert_eq!(two_turn.text, "多行\n正文");
        let two_results = tool_results("ollama", &two_turn.tool_calls, &[ToolExecution::success("删完"), ToolExecution::success("改完")]).unwrap();
        assert_eq!(two_results[0]["tool_name"], "launcher_delete_version");
        assert_eq!(two_results[1]["tool_name"], "launcher_rename_version");
    }

    #[test]
    fn anthropic_roundtrip_preserves_tool_use_opaque_blocks() {
        let response = json!({"id":"msg","content":[{"type":"text","text":"确认"},{"type":"tool_use","id":"tool-1","name":"launcher_delete_account","input":{"account":"cat"},"cache_control":{"type":"ephemeral"}}],"stop_reason":"tool_use"});
        let turn = parse_turn("anthropic", &response).unwrap();
        assert_eq!(turn.text, "确认");
        assert_eq!(turn.assistant["content"][1]["cache_control"]["type"], "ephemeral");
        let messages = tool_results("anthropic", &turn.tool_calls, &[ToolExecution::failure("用户拒绝")]).unwrap();
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["tool_use_id"], "tool-1");
        assert_eq!(messages[0]["content"][0]["is_error"], true);
    }

    #[test]
    fn gemini_roundtrip_generates_stable_id_and_preserves_thought_signature() {
        let response = json!({"candidates":[{"content":{"role":"model","parts":[{"text":"执行","thoughtSignature":"opaque-signature"},{"functionCall":{"name":"launcher_delete_version","args":{"versionId":"1.20.1"}}}]}}]});
        let first = parse_turn("gemini", &response).unwrap();
        let second = parse_turn("gemini", &response).unwrap();
        assert_eq!(first.tool_calls, second.tool_calls);
        assert_eq!(first.tool_calls[0].provider_call_id.len(), 36);
        assert_eq!(first.assistant["parts"][0]["thoughtSignature"], "opaque-signature");
        let messages = tool_results("gemini", &first.tool_calls, &[ToolExecution::success("ok")]).unwrap();
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["parts"][0]["functionResponse"]["name"], "launcher_delete_version");
        assert_eq!(messages[0]["parts"][0]["functionResponse"]["response"]["callId"], first.tool_calls[0].provider_call_id);
    }

    #[test]
    fn malformed_unknown_duplicate_and_mismatched_inputs_are_rejected() {
        assert!(parse_turn("unknown", &json!({})).is_err());
        assert!(parse_turn("openai", &json!({"choices":[]})).is_err());
        assert!(parse_turn("openai", &json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"x","function":{"name":"launcher_delete_version","arguments":"{\"versionId\":\"1.20.1\"}"}}]}}]})).is_ok());
        assert!(parse_turn("openai", &json!({"choices":[{"message":{"role":"assistant","content":"多行\n正文","tool_calls":[]}}]})).is_ok());
        let nul = String::from("坏\0正文");
        assert!(parse_turn("openai", &json!({"choices":[{"message":{"role":"assistant","content":nul,"tool_calls":[]}}]})).is_err());
        assert!(parse_turn("anthropic", &json!({"content":[{"type":"tool_use","id":"x","name":"launcher_delete_version","input":{}}]})).is_err());
        assert!(parse_turn("gemini", &json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"launcher_delete_version","args":[]}}]}}]})).is_err());
        let a = intent("launcher_delete_version", json!({"versionId":"one"}));
        let b = intent("launcher_delete_version", json!({"versionId":"two"}));
        assert!(tool_results("openai", &[a.clone()], &[]).is_err());
        assert!(tool_results("openai", &[a.clone(), a.clone()], &[ToolExecution::success("x"), ToolExecution::success("y")]).is_err());
        assert!(tool_results("bad", &[], &[]).is_err());
        assert!(tool_results("gemini", &[a, b], &[ToolExecution::success("x")]).is_err());
    }
}
