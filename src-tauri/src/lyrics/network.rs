//! 固定网易云公开查询；曲目信息只在用户开启歌词时发送，不接受调用方 URL。
use super::model::{parse_lrc, score, Outcome, Query, MAX_TEXT};
use serde_json::Value;
use std::time::Duration;
const ORIGIN: &str = "https://music.163.com";
const MAX_JSON: usize = 2 * 1024 * 1024;

pub(super) fn client() -> std::result::Result<reqwest::Client, ()> {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(8))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build().map_err(|_| ())
}
async fn json(client: &reqwest::Client, path: &str, query: &[(&str, String)]) -> std::result::Result<Value, ()> {
    let mut response = client.get(format!("{ORIGIN}{path}")).query(query)
        .header(reqwest::header::REFERER, "https://music.163.com/")
        .header(reqwest::header::COOKIE, "appver=2.0.2; os=pc").send().await.map_err(|_| ())?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > MAX_JSON as u64) { return Err(()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_JSON { return Err(()); }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if value.is_object() { Ok(value) } else { Err(()) }
}
fn candidates(payload: &Value, query: &Query) -> (usize, Vec<(u64, f64)>) {
    let Some(songs) = payload.get("result").and_then(|v| v.get("songs")).and_then(Value::as_array) else { return (0, Vec::new()); };
    let mut candidates = Vec::new(); let mut parsed = 0;
    for song in songs.iter().take(64) {
        let Some(id) = song.get("id").and_then(Value::as_u64).filter(|n| *n > 0) else { continue; };
        let Some(name) = song.get("name").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= MAX_TEXT) else { continue; };
        let artists = song.get("artists").or_else(|| song.get("ar")).and_then(Value::as_array).map(|array| array.iter().take(32)
            .filter_map(|artist| artist.get("name").and_then(Value::as_str).filter(|s| s.len() <= MAX_TEXT).map(str::to_owned)).collect::<Vec<_>>()).unwrap_or_default();
        let duration = song.get("duration").or_else(|| song.get("dt")).and_then(Value::as_f64).unwrap_or(0.0) / 1000.0;
        parsed += 1;
        if let Some(score) = score(name, &artists, duration, query) { candidates.push((id, score)); }
    }
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1)); (parsed, candidates)
}
async fn search(client: &reqwest::Client, term: String, query: &Query) -> std::result::Result<(usize, Vec<(u64, f64)>), ()> {
    let payload = json(client, "/api/search/get/web", &[("s", term), ("type", "1".into()), ("offset", "0".into()), ("limit", "8".into())]).await?;
    Ok(candidates(&payload, query))
}
pub(super) async fn fetch(client: reqwest::Client, query: Query) -> Outcome {
    let first = if query.artist.trim().is_empty() { query.title.trim().to_owned() } else { format!("{} {}", query.title.trim(), query.artist.trim()) };
    let (count, mut found) = match search(&client, first, &query).await { Ok(value) => value, Err(()) => return Outcome::Network };
    // 对照原实现：仅在搜索真的没有候选时回退，低相似度不是另一次搜索的理由。
    if count == 0 && !query.artist.trim().is_empty() {
        found = match search(&client, query.title.trim().to_owned(), &query).await { Ok((_, value)) => value, Err(()) => return Outcome::Network };
    }
    let mut attempted = 0; let mut failed = 0;
    for (id, _) in found.into_iter().take(3) {
        attempted += 1;
        let payload = match json(&client, "/api/song/lyric", &[("id", id.to_string()), ("lv", "-1".into()), ("kv", "-1".into()), ("tv", "-1".into())]).await {
            Ok(value) => value, Err(()) => { failed += 1; continue; }
        };
        if let Some(raw) = ["lrc", "tlyric"].iter().filter_map(|key| payload.get(key).and_then(|v| v.get("lyric")).and_then(Value::as_str)).find(|raw| !raw.trim().is_empty()) {
            let lines = parse_lrc(raw); if !lines.is_empty() { return Outcome::Ready(lines); }
        }
    }
    if attempted > 0 && failed == attempted { Outcome::Network } else { Outcome::Empty }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn metadata_is_bounded_and_candidate_order_uses_the_same_query() {
        let q = Query { title: "测试曲".into(), artist: "歌手甲".into(), duration: 120.0 };
        let rows = candidates(&serde_json::json!({"result":{"songs":[
            {"id":2,"name":"测试曲","artists":[{"name":"其他"}],"duration":180000},
            {"id":1,"name":"测试曲","artists":[{"name":"歌手甲"}],"duration":120000},
            {"id":-1,"name":"测试曲"}, {"id":3,"name":"不同歌曲"}
        ]}}), &q);
        assert_eq!(rows.0, 3); assert_eq!(rows.1[0].0, 1); assert_eq!(rows.1.len(), 2);
    }
}
