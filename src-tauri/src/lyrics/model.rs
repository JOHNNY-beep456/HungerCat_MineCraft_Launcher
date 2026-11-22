//! 歌词纯领域模型：沿用 Electron 的曲目匹配、SMTC 快照指纹与手动逐句校准。
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

pub const MAX_TEXT: usize = 2048;
pub const MAX_LINES: usize = 4096;
pub const MAX_LRC: usize = 512 * 1024;
#[derive(Clone, Debug, Default)]
pub struct Session {
    pub title: String, pub artist: String, pub source: String,
    pub playing: Option<bool>, pub start: f64, pub pos: f64, pub end: f64, pub updated: f64,
}
impl Session {
    pub fn duration(&self) -> f64 { (positive(self.end) - positive(self.start)).max(0.0) }
    fn published(&self) -> bool { self.end > 0.0 || usable(self.updated) || self.pos > positive(self.start) }
    fn same_song(&self, other: &Self) -> bool {
        normalize(&self.title) == normalize(&other.title) && normalize(&self.artist) == normalize(&other.artist)
            && (self.duration() <= 0.0 || other.duration() <= 0.0 || (self.duration() - other.duration()).abs() <= 5.0)
    }
    fn key(&self) -> String { format!("{}|{}|{}", normalize(&self.title), normalize(&self.artist), if self.duration() > 0.0 { self.duration().round().to_string() } else { "?".into() }) }
}
fn positive(value: f64) -> f64 { if value.is_finite() && value > 0.0 { value } else { 0.0 } }
fn usable(value: f64) -> bool { value.is_finite() && value >= 946_684_800_000.0 }
#[derive(Clone, Debug, PartialEq)]
pub struct Line { pub time: f64, pub text: String }
#[derive(Clone, Debug)]
pub struct Query { pub title: String, pub artist: String, pub duration: f64 }
#[derive(Clone, Debug)]
pub struct Request { pub generation: u64, pub query: Query }
#[derive(Clone, Debug)]
pub enum Outcome { Ready(Vec<Line>), Empty, Network }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub enabled: bool, pub status: String, pub title: String, pub artist: String, pub source: String,
    pub prev: String, pub current: String, pub next: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
impl Snapshot {
    fn blank(status: &str) -> Self { Self { enabled: false, status: status.into(), title: String::new(), artist: String::new(), source: String::new(), prev: String::new(), current: String::new(), next: String::new(), message: None } }
}
#[derive(Clone, Debug)]
pub struct Preferences { pub wanted: bool, pub language: String, pub opacity: f64 }
impl Default for Preferences { fn default() -> Self { Self { wanted: false, language: "zh-CN".into(), opacity: 0.8 } } }
#[derive(Default)]
struct Progress { anchored: bool, base: f64, at: f64, playing: bool, last_pos: f64, last_updated: f64 }
impl Progress {
    fn position(&self, now: f64) -> f64 { if !self.anchored { 0.0 } else { self.base + if self.playing { (now - self.at) / 1000.0 } else { 0.0 } } }
    fn anchor(&mut self, pos: f64, now: f64, playing: bool, raw: f64, updated: f64) {
        *self = Self { anchored: true, base: pos, at: now, playing, last_pos: raw, last_updated: if usable(updated) { updated } else { 0.0 } };
    }
    fn sample(&mut self, session: &Session, now: f64) {
        let playing = session.playing.unwrap_or(self.playing);
        let changed = session.playing.is_some() && playing != self.playing;
        let updated = if usable(session.updated) { session.updated } else { 0.0 };
        let fingerprint = session.pos != self.last_pos || updated != self.last_updated;
        if session.published() && (!self.anchored || fingerprint) {
            let pos = (positive(session.pos) - positive(session.start)).max(0.0)
                + if playing && usable(session.updated) { (now - session.updated).max(0.0) / 1000.0 } else { 0.0 };
            self.anchor(pos, now, playing, session.pos, session.updated);
        } else if changed {
            self.base = self.position(now); self.at = now; self.playing = playing; self.anchored = true;
        }
    }
}
pub struct Model {
    pub preferences: Preferences, pub snapshot: Snapshot, pub revision: u64, pub generation: u64,
    session: Option<Session>, progress: Progress, lines: Vec<Line>, retry_at: f64,
    cache: VecDeque<(String, Vec<Line>)>,
}
impl Default for Model {
    fn default() -> Self { Self { preferences: Preferences::default(), snapshot: Snapshot::blank("off"), revision: 0, generation: 0, session: None, progress: Progress::default(), lines: Vec::new(), retry_at: 0.0, cache: VecDeque::new() } }
}
impl Model {
    fn bump(&mut self) { self.revision = self.revision.saturating_add(1); }
    fn reset(&mut self, status: &str) {
        self.generation = self.generation.wrapping_add(1); self.session = None; self.lines.clear();
        self.progress = Progress::default(); self.retry_at = 0.0; self.snapshot = Snapshot::blank(status); self.bump();
    }
    pub fn configure(&mut self, preferences: Preferences) {
        let changed = self.preferences.wanted != preferences.wanted || self.preferences.language != preferences.language || self.preferences.opacity != preferences.opacity;
        let switch = self.preferences.wanted != preferences.wanted;
        self.preferences = preferences;
        if switch { self.reset(if self.preferences.wanted { "idle" } else { "off" }); }
        else if changed { self.bump(); }
    }
    pub fn sample(&mut self, session: Option<Session>, now: f64) -> Option<Request> {
        if !self.preferences.wanted { return None; }
        let Some(session) = session else { if self.session.is_some() { self.reset("idle"); } return None; };
        if self.session.as_ref().is_none_or(|old| !old.same_song(&session)) {
            self.generation = self.generation.wrapping_add(1); self.lines.clear(); self.retry_at = 0.0; self.progress = Progress::default();
            self.snapshot = Snapshot { enabled: true, status: "loading".into(), title: session.title.clone(), artist: session.artist.clone(), source: session.source.clone(), ..Snapshot::blank("loading") };
            self.progress.sample(&session, now);
            let cached = self.cache.iter().find(|(key, _)| key == &session.key()).map(|(_, lines)| lines.clone());
            let request = Request { generation: self.generation, query: Query { title: session.title.clone(), artist: session.artist.clone(), duration: session.duration() } };
            self.session = Some(session); self.bump();
            if let Some(lines) = cached { self.lines = lines; self.snapshot.status = "sync".into(); self.tick(now); None } else { Some(request) }
        } else {
            self.progress.sample(&session, now);
            if self.snapshot.title != session.title || self.snapshot.artist != session.artist || self.snapshot.source != session.source {
                self.snapshot.title = session.title.clone(); self.snapshot.artist = session.artist.clone(); self.snapshot.source = session.source.clone(); self.bump();
            }
            self.session = Some(session); None
        }
    }
    pub fn result(&mut self, generation: u64, result: Outcome, now: f64) {
        if !self.preferences.wanted || generation != self.generation || self.session.is_none() { return; }
        match result {
            Outcome::Ready(lines) if !lines.is_empty() => {
                let key = self.session.as_ref().unwrap().key(); self.cache.retain(|(old, _)| old != &key);
                self.cache.push_back((key, lines.clone())); while self.cache.len() > 12 { self.cache.pop_front(); }
                self.lines = lines; self.snapshot.status = "sync".into(); self.snapshot.message = None; self.retry_at = 0.0;
            }
            Outcome::Network => { self.snapshot.status = "error".into(); self.retry_at = now + 30_000.0; self.snapshot.message = Some(message(&self.preferences.language, true)); }
            _ => { self.snapshot.status = "nolyric".into(); self.retry_at = 0.0; self.snapshot.message = Some(message(&self.preferences.language, false)); }
        }
        self.bump(); self.tick(now);
    }
    pub fn retry(&mut self, now: f64) -> Option<Request> {
        if !self.preferences.wanted || self.retry_at <= 0.0 || now < self.retry_at { return None; }
        let session = self.session.as_ref()?; self.retry_at = 0.0; self.generation = self.generation.wrapping_add(1); self.snapshot.status = "loading".into(); self.snapshot.message = None;
        let request = Request { generation: self.generation, query: Query { title: session.title.clone(), artist: session.artist.clone(), duration: session.duration() } };
        self.bump(); Some(request)
    }
    fn position(&self, now: f64) -> f64 {
        let pos = self.progress.position(now); let duration = self.session.as_ref().map_or(0.0, Session::duration);
        if duration > 0.0 { pos.min(duration) } else { pos }
    }
    pub fn tick(&mut self, now: f64) {
        if self.snapshot.status != "sync" || self.lines.is_empty() { return; }
        let index = locate(&self.lines, self.position(now));
        let current = index.map(|i| self.lines[i].text.clone()).unwrap_or_default();
        let prev = index.and_then(|i| i.checked_sub(1)).map(|i| self.lines[i].text.clone()).unwrap_or_default();
        let next = self.lines.get(index.map_or(0, |i| i + 1)).map(|line| line.text.clone()).unwrap_or_default();
        if (prev.as_str(), current.as_str(), next.as_str()) != (self.snapshot.prev.as_str(), self.snapshot.current.as_str(), self.snapshot.next.as_str()) {
            self.snapshot.prev = prev; self.snapshot.current = current; self.snapshot.next = next; self.bump();
        }
    }
    pub fn nudge(&mut self, direction: i32, now: f64) {
        if !self.preferences.wanted || self.lines.is_empty() || !matches!(direction, -1 | 1) { return; }
        let index = locate(&self.lines, self.position(now)); let from = index.unwrap_or(0);
        let target = (from as i64 + direction as i64).clamp(0, self.lines.len() as i64 - 1) as usize;
        if Some(target) == index { return; }
        self.progress.anchor(self.lines[target].time, now, self.progress.playing, self.lines[target].time, 0.0);
        self.tick(now); self.bump();
    }
}
fn message(language: &str, network: bool) -> String {
    match (language, network) {
        ("en", true) => "Unable to fetch lyrics; retrying later", ("en", false) => "No lyrics found for this song",
        ("zh-TW", true) => "取得歌詞失敗（網路），稍後自動重試", ("zh-TW", false) => "未找到這首歌的歌詞",
        (_, true) => "取歌词失败（网络），稍后自动重试", (_, false) => "未找到这首歌的歌词",
    }.into()
}
pub fn locate(lines: &[Line], position: f64) -> Option<usize> { lines.partition_point(|line| line.time <= position + 0.2).checked_sub(1) }
pub fn normalize(raw: &str) -> String {
    let brackets = regex::Regex::new(r"[（(【\[].*?[）)】\]]").unwrap();
    let punctuation = "-_·、,，.。!！?？'\":：;；/\\|~`@#$%^&*+=<>（）()[]{}";
    brackets.replace_all(raw, " ").chars().filter(|c| !c.is_whitespace() && !punctuation.contains(*c)).flat_map(char::to_lowercase).collect()
}
fn grams(raw: &str) -> HashSet<Vec<u16>> {
    let chars: Vec<u16> = raw.encode_utf16().collect();
    if chars.len() < 2 { if chars.is_empty() { HashSet::new() } else { [chars].into_iter().collect() } }
    else { chars.windows(2).map(|x| x.to_vec()).collect() }
}
fn dice(a: &str, b: &str) -> f64 { let a = grams(a); let b = grams(b); if a.is_empty() || b.is_empty() { 0.0 } else { 2.0 * a.intersection(&b).count() as f64 / (a.len() + b.len()) as f64 } }
pub fn score(name: &str, artists: &[String], duration: f64, query: &Query) -> Option<f64> {
    let title = dice(&normalize(name), &normalize(&query.title)); let want = normalize(&query.artist);
    let artist = if want.is_empty() { 0.5 } else { artists.iter().map(|value| { let got = normalize(value); if got == want { 1.0 } else if !got.is_empty() && (got.contains(&want) || want.contains(&got)) { 0.9 } else { dice(&got, &want) } }).fold(0.0_f64, f64::max) };
    let diff = (duration - query.duration).abs();
    let duration = if duration <= 0.0 || query.duration <= 0.0 { 0.5 } else if diff <= 2.5 { 1.0 } else if diff <= 6.0 { 0.7 } else if diff <= 15.0 { 0.35 } else { 0.0 };
    let total = title * 0.55 + artist * 0.25 + duration * 0.2;
    (title >= 0.6 && total >= 0.5 && (!query.artist.trim().is_empty() || query.duration > 0.0 || title >= 0.85)).then_some(total)
}
pub fn parse_lrc(raw: &str) -> Vec<Line> {
    if raw.len() > MAX_LRC { return Vec::new(); }
    let regex = regex::Regex::new(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]").unwrap(); let mut out = Vec::new();
    for line in raw.lines() {
        let text = regex.replace_all(line, "").trim().to_owned(); if text.is_empty() || text.len() > MAX_TEXT { continue; }
        for stamp in regex.captures_iter(line) {
            if out.len() >= MAX_LINES { return Vec::new(); }
            let fraction = stamp.get(3).map(|s| s.as_str()).unwrap_or("");
            let time = stamp[1].parse::<f64>().unwrap_or(0.0) * 60.0 + stamp[2].parse::<f64>().unwrap_or(0.0)
                + if fraction.is_empty() { 0.0 } else { format!("0.{fraction}").parse::<f64>().unwrap_or(0.0) };
            out.push(Line { time, text: text.clone() });
        }
    }
    out.sort_by(|a, b| a.time.total_cmp(&b.time)); out.dedup_by(|a, b| a.time == b.time && a.text == b.text);
    let placeholder = ["纯音乐", "純音樂", "没有填词", "沒有填詞", "请您欣赏", "請您欣賞", "此歌曲", "没有歌词", "instrumental"];
    if out.len() <= 3 && out.iter().any(|line| placeholder.iter().any(|p| line.text.to_lowercase().contains(p))) { return Vec::new(); }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn lrc_preserves_multiple_stamps_and_rejects_placeholder_or_over_budget() {
        let lines = parse_lrc("[ti:x]\n[00:01.00]甲\n[00:05.5][01:20.123]乙\n[00:12:34]丙");
        assert_eq!(lines.iter().map(|x| x.time).collect::<Vec<_>>(), vec![1.0,5.5,12.34,80.123]);
        assert!(parse_lrc("[00:05]纯音乐，请欣赏").is_empty()); assert!(parse_lrc(&"x".repeat(MAX_LRC+1)).is_empty());
        assert_eq!(locate(&lines, 0.0), None); assert_eq!(locate(&lines, 5.4), Some(1));
    }
    #[test] fn official_candidate_matching_requires_title_and_prefers_the_same_version() {
        let query = Query { title:"测试曲".into(), artist:"测试歌手".into(), duration:300.0 };
        let right = score("测试曲 (Live)",&["测试歌手".into()],300.0,&query).unwrap();
        let other = score("测试曲",&["其他歌手".into()],240.0,&query).unwrap(); assert!(right > other);
        assert!(score("完全无关", &[], 300.0, &query).is_none());
    }
    #[test] fn playing_epoch_clock_rollback_matches_the_existing_progress_formula() {
        let mut progress = Progress::default(); progress.anchor(5.0, 10_000.0, true, 5.0, 0.0);
        assert_eq!(progress.position(9_000.0), 4.0);
    }
    #[test] fn repeated_samples_pause_seek_nudge_and_disabled_late_result_follow_the_same_model() {
        let mut m = Model::default(); m.configure(Preferences { wanted:true, ..Preferences::default() });
        let mut session = Session { title:"fixture".into(), playing:Some(true), end:300.0, pos:10.0, updated:1_700_000_000_000.0, ..Session::default() };
        let request = m.sample(Some(session.clone()),1_700_000_000_000.0).unwrap();
        m.result(request.generation,Outcome::Ready(parse_lrc("[00:00]a\n[00:10]b\n[00:20]c")),1_700_000_000_000.0);
        m.sample(Some(session.clone()),1_700_000_005_000.0); assert_eq!(m.position(1_700_000_005_000.0),15.0);
        session.playing=Some(false);session.pos=0.0;session.end=0.0;session.updated=0.0;
        m.sample(Some(session.clone()),1_700_000_006_000.0); assert_eq!(m.position(1_700_000_009_000.0),16.0);
        m.nudge(1,1_700_000_009_000.0); assert_eq!(m.snapshot.current,"c");
        m.configure(Preferences::default()); m.result(request.generation,Outcome::Network,1_700_000_010_000.0);
        assert_eq!(m.snapshot.status,"off"); assert!(!m.snapshot.enabled);
    }
}
