//! 官方协议的离线业务夹具；Transport 不发送网络请求，不接触真实实例或凭据。
use super::*;
use serde_json::json;
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::{Mutex, atomic::Ordering}};
use reqwest::{Method, Url};

struct Fixture { replies: BTreeMap<String, Result<Value>>, requests: Mutex<Vec<(String, bool, Method)>> }
impl Fixture {
    fn new() -> Self { Self { replies: BTreeMap::new(), requests: Mutex::new(Vec::new()) } }
    fn reply(&mut self, path: &str, value: Value) { self.replies.insert(path.into(), Ok(value)); }
    fn missing(&mut self, path: &str) { self.replies.insert(path.into(), Err("资源项目或版本不存在（HTTP 404）".into())); }
    fn count(&self) -> usize { self.requests.lock().unwrap().len() }
}
impl Transport for Fixture {
    fn request<'a>(&'a self, url: Url, _settings: &'a Value, cf: bool, method: Method, body: Option<Value>) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
        let key = if url.path().ends_with("/fingerprints/432") {
            format!("{}:{}", url.path(), body.as_ref().and_then(|v| v["fingerprints"][0].as_u64()).unwrap_or(0))
        } else { url.path().into() };
        self.requests.lock().unwrap().push((key.clone(), cf, method));
        let reply = self.replies.get(&key).cloned().unwrap_or_else(|| Err(format!("fixture response missing: {key}")));
        Box::pin(async move { reply })
    }
}
fn input() -> LocalQuery {
    LocalQuery { kind: ResourceKind::Mod, path: std::env::temp_dir().join("hcmcl-dependency-plan").join("mods/main.jar"), filename: "main.jar".into(), enabled: true,
        size: 10, sha1: "a".repeat(40), sha512: "b".repeat(128), fingerprint: 17, mc_version: "1.20.1".into(), loader: Some("fabric".into()), shader_runtimes: vec![] }
}
fn settings() -> Value { json!({"mode":"online"}) }
fn project(id: &str) -> Value { json!({"id":id,"slug":id,"title":id,"project_type":"mod","client_side":"required"}) }
fn version(project: &str, id: &str, hash: (&str,&str), dependencies: Value) -> Value {
    json!({"id":id,"project_id":project,"version_number":id,"date_published":if id.ends_with("old") {"2025-01-01T00:00:00Z"} else {"2026-01-01T00:00:00Z"},
        "status":"listed","game_versions":["1.20.1"],"loaders":["fabric"],"dependencies":dependencies,
        "files":[{"filename":format!("{project}.jar"),"url":format!("https://cdn.modrinth.com/data/{project}/versions/{id}/{project}.jar"),"size":10,"primary":true,
            "hashes":{"sha1":hash.0.repeat(40),"sha512":hash.1.repeat(128)}}]})
}
fn expected(query: &LocalQuery, source: &str) -> UpdateInfo {
    let (title, current, latest, url) = if source == "modrinth" { ("main", "main-old", "main-next", "https://cdn.modrinth.com/data/main/versions/main-next/main.jar") }
        else { ("main", "main-old", "main-next", "https://edge.forgecdn.net/files/5000/002/main.jar") };
    UpdateInfo { path: query.path.to_str().unwrap().into(), kind: ResourceKind::Mod, current_version: current.into(), latest_version: latest.into(),
        file_url: url.into(), filename: "main.jar".into(), size: 10, slug: title.into(), title: title.into() }
}
fn mr_fixture(deps: Value) -> Fixture {
    let mut fixture = Fixture::new();
    let old = version("main", "main-old", ("a","b"), json!([]));
    let next = version("main", "main-next", ("c","d"), deps);
    fixture.reply(&format!("/v2/version_file/{}", "b".repeat(128)), old.clone());
    fixture.reply("/v2/project/main", project("main"));
    fixture.reply("/v2/project/main/version", json!([old, next.clone()]));
    fixture.reply("/v2/version/main-next", next);
    fixture
}
fn add_mr(fixture: &mut Fixture, project_id: &str, version_id: &str, hashes: (&str,&str), deps: Value) -> Value {
    let raw = version(project_id, version_id, hashes, deps);
    fixture.reply(&format!("/v2/project/{project_id}"), project(project_id));
    fixture.reply(&format!("/v2/version/{version_id}"), raw.clone());
    fixture.reply(&format!("/v2/project/{project_id}/version"), json!([raw.clone()]));
    fixture.reply(&format!("/v2/version_file/{}", hashes.1.repeat(128)), raw.clone()); raw
}
fn local_dependency(base: &LocalQuery, enabled: bool, hashes: (&str,&str)) -> LocalQuery {
    let mut old = base.clone(); old.filename = "dep.jar".into(); old.path = base.path.parent().unwrap().join(if enabled {"dep.jar"} else {"dep.jar.disabled"});
    old.enabled = enabled; old.sha1 = hashes.0.repeat(40); old.sha512 = hashes.1.repeat(128); old.fingerprint = 19; old
}
async fn prepare(fixture: &Fixture, query: &LocalQuery, installed: &[LocalQuery], source: &str) -> Result<PreparedUpdate> {
    prepare_with(fixture, query, &expected(query,source), installed, &settings(), &Arc::new(AtomicBool::new(false)), Arc::new(|| Ok(()))).await
}
#[tokio::test]
async fn modrinth_required_closure_uses_version_only_and_skips_optional_embedded() {
    let query = input(); let mut fixture = mr_fixture(json!([
        {"project_id":null,"version_id":"dep-next","dependency_type":"required"},
        {"project_id":"optional","version_id":null,"dependency_type":"optional"},
        {"project_id":"embedded","version_id":null,"dependency_type":"embedded"},
        {"project_id":null,"version_id":null,"file_name":"bundled.jar","dependency_type":"embedded"},
        {"project_id":null,"version_id":null,"file_name":"optional.jar","dependency_type":"optional"}]));
    add_mr(&mut fixture, "dep", "dep-next", ("e","f"), json!([]));
    let result = prepare(&fixture, &query, &[query.clone()], "modrinth").await.unwrap();
    assert_eq!(result.changes.len(), 2);
    assert!(matches!(&result.changes[0], PlannedChange::Replace{old,..} if same_query(old,&query)));
    assert!(matches!(&result.changes[1], PlannedChange::Install{file} if file.project_id=="dep" && file.version_id=="dep-next"));
    assert!(!fixture.requests.lock().unwrap().iter().any(|(path,_,_)| path.contains("optional") || path.contains("embedded")));
}
#[tokio::test]
async fn installed_exact_dependency_is_retained_or_explicitly_enabled() {
    for enabled in [true,false] {
        let query=input(); let dependency=local_dependency(&query,enabled,("e","f"));
        let mut fixture=mr_fixture(json!([{"project_id":"dep","version_id":"dep-next","dependency_type":"required"}]));
        add_mr(&mut fixture,"dep","dep-next",("e","f"),json!([]));
        let result=prepare(&fixture,&query,&[query.clone(),dependency.clone()],"modrinth").await.unwrap();
        assert_eq!(result.changes.len(),if enabled {1}else{2});
        if !enabled { assert!(matches!(&result.changes[1], PlannedChange::Enable{old} if same_query(old,&dependency))); }
    }
}
#[tokio::test]
async fn known_older_dependency_is_replaced_and_disabled_older_requires_enable_first() {
    for enabled in [true,false] {
        let query=input(); let dependency=local_dependency(&query,enabled,("1","2"));
        let mut fixture=mr_fixture(json!([{"project_id":"dep","version_id":"dep-next","dependency_type":"required"}]));
        add_mr(&mut fixture,"dep","dep-old",("1","2"),json!([]));
        add_mr(&mut fixture,"dep","dep-next",("e","f"),json!([]));
        let result=prepare(&fixture,&query,&[query.clone(),dependency.clone()],"modrinth").await;
        if enabled { let result=result.unwrap(); assert!(matches!(&result.changes[1],PlannedChange::Replace{old,file} if same_query(old,&dependency) && file.version_id=="dep-next")); }
        else { assert!(result.unwrap_err().contains("disabled")); }
    }
}
#[tokio::test]
async fn declared_hashes_are_all_required_and_name_alone_never_replaces() {
    let query=input(); let dependency=local_dependency(&query,true,("e","2"));
    let mut fixture=mr_fixture(json!([{"project_id":"dep","version_id":"dep-next","dependency_type":"required"}]));
    add_mr(&mut fixture,"dep","dep-next",("e","f"),json!([]));
    fixture.missing(&format!("/v2/version_file/{}","2".repeat(128)));
    let result=prepare(&fixture,&query,&[query.clone(),dependency],"modrinth").await;
    assert!(result.unwrap_err().contains("conflict"));
}
#[tokio::test]
async fn incompatible_checks_installed_project_versions_and_selected_plan() {
    for against_plan in [false,true] {
        let query=input(); let dependency=local_dependency(&query,true,("e","f"));
        let mut deps=vec![json!({"project_id":"dep","version_id":null,"dependency_type":"incompatible"})];
        if against_plan { deps.push(json!({"project_id":"dep","version_id":"dep-next","dependency_type":"required"})); }
        let mut fixture=mr_fixture(json!(deps)); add_mr(&mut fixture,"dep","dep-next",("e","f"),json!([]));
        let installed=if against_plan {vec![query.clone()]}else{vec![query.clone(),dependency]};
        assert!(prepare(&fixture,&query,&installed,"modrinth").await.unwrap_err().contains("conflict"));
    }
}
#[tokio::test]
async fn repeated_required_identity_is_deduplicated_and_cycles_are_rejected() {
    let query=input(); let relation=json!({"project_id":"dep","version_id":"dep-next","dependency_type":"required"});
    let mut fixture=mr_fixture(json!([relation.clone(),relation])); add_mr(&mut fixture,"dep","dep-next",("e","f"),json!([]));
    assert_eq!(prepare(&fixture,&query,&[query.clone()],"modrinth").await.unwrap().changes.len(),2);
    add_mr(&mut fixture,"dep","dep-next",("e","f"),json!([{"project_id":"main","version_id":"main-next","dependency_type":"required"}]));
    assert!(prepare(&fixture,&query,&[query.clone()],"modrinth").await.unwrap_err().contains("conflict"));
}
#[tokio::test]
async fn main_size_is_included_in_total_and_cross_kind_is_explicit() {
    let query=input(); let mut fixture=mr_fixture(json!([{"project_id":"dep","version_id":"dep-next","dependency_type":"required"}]));
    let mut raw=add_mr(&mut fixture,"dep","dep-next",("e","f"),json!([])); raw["files"][0]["size"]=json!(MAX_BYTES);
    fixture.reply("/v2/version/dep-next",raw);
    assert!(prepare(&fixture,&query,&[query.clone()],"modrinth").await.unwrap_err().contains("budget"));
    let mut other=project("dep"); other["project_type"]=json!("resourcepack");fixture.reply("/v2/project/dep",other);
    assert!(prepare(&fixture,&query,&[query.clone()],"modrinth").await.unwrap_err().contains("Cross-kind"));
}
#[tokio::test]
async fn cancellation_and_metadata_only_stop_before_transport() {
    let query=input(); let fixture=mr_fixture(json!([]));let cancelled=Arc::new(AtomicBool::new(true));
    assert!(prepare_with(&fixture,&query,&expected(&query,"modrinth"),&[query.clone()],&settings(),&cancelled,Arc::new(||Ok(()))).await.is_err());
    cancelled.store(false,Ordering::Release);
    assert!(prepare_with(&fixture,&query,&expected(&query,"modrinth"),&[query.clone()],&json!({"metadataOnlyMods":true}),&cancelled,Arc::new(||Ok(()))).await.is_err());
    assert_eq!(fixture.count(),0);
}
fn cf_file(project:u64,id:u64,filename:&str,sha1:&str,date:&str,deps:Value)->Value {
    json!({"id":id,"modId":project,"gameId":432,"isAvailable":true,"fileName":filename,"displayName":if id==5_000_001 {"main-old"}else if id==5_000_002 {"main-next"}else{"dep-next"},
        "downloadUrl":format!("https://edge.forgecdn.net/files/{}/{:03}/{filename}",id/1000,id%1000),"fileLength":10,"hashes":[{"algo":1,"value":sha1.repeat(40)}],
        "gameVersions":["1.20.1","Fabric"],"fileDate":date,"fileFingerprint":17,"dependencies":deps})
}
#[tokio::test]
async fn curseforge_required_uses_real_file_shape_and_official_project_class() {
    let query=input();let mut fixture=Fixture::new();fixture.missing(&format!("/v2/version_file/{}",query.sha512));
    let old=cf_file(100,5_000_001,"main.jar","a","2025-01-01T00:00:00Z",json!([]));
    let next=cf_file(100,5_000_002,"main.jar","c","2026-01-01T00:00:00Z",json!([{"modId":200,"relationType":3}]));
    fixture.reply("/v1/fingerprints/432:17",json!({"data":{"exactMatches":[{"id":100,"file":old.clone()}]}}));
    fixture.reply("/v1/mods/100",json!({"data":{"id":100,"gameId":432,"classId":6,"allowModDistribution":true,"slug":"main","name":"main"}}));
    fixture.reply("/v1/mods/100/files/5000001",json!({"data":old}));
    fixture.reply("/v1/mods/100/files",json!({"data":[next.clone()],"pagination":{"index":0,"pageSize":50,"resultCount":1,"totalCount":1}}));
    fixture.reply("/v1/mods/100/files/5000002",json!({"data":next}));
    let dep=cf_file(200,5_100_001,"dep.jar","e","2026-01-01T00:00:00Z",json!([]));
    fixture.reply("/v1/mods/200",json!({"data":{"id":200,"gameId":432,"classId":6,"allowModDistribution":true,"name":"dependency"}}));
    fixture.reply("/v1/mods/200/files",json!({"data":[dep],"pagination":{"index":0,"pageSize":50,"resultCount":1,"totalCount":1}}));
    let result=prepare(&fixture,&query,&[query.clone()],"curseforge").await.unwrap();
    assert_eq!(result.changes.len(),2);assert!(matches!(&result.changes[1],PlannedChange::Install{file} if file.source=="curseforge" && file.project_id=="200"));
    let requests=fixture.requests.lock().unwrap();assert!(requests.iter().filter(|(path,_,_)|path.starts_with("/v1/")).all(|(_,cf,_)|*cf));
}
