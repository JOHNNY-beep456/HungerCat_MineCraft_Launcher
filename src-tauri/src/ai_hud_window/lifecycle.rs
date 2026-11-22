//! 原生宿主与确定性夹具共用的状态；destroy 入队绝不等于旧标签已经释放。
const RETRY_MS: u64 = 250;
const WAIT_MS: u64 = 2_500;
pub(super) const MAX_CLOSE_RETRIES: u8 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Registry { Empty, Owned, Other, Unavailable }
impl Registry {
    // manager 的 window/webview 标签可能先后清理，只有双空才投影为 Empty。
    pub fn observe(window: bool, webview: bool, owner: bool, destroyed: bool, identity: Option<bool>) -> Self {
        if !window && !webview { return Self::Empty; }
        if !owner { return Self::Other; }
        if destroyed { return Self::Owned; }
        if !window || !webview { return Self::Unavailable; }
        match identity { Some(true) => Self::Owned, Some(false) => Self::Other, None => Self::Unavailable }
    }
}
#[derive(Clone, Debug)]
pub(super) struct Desired { pub enabled: bool, pub revision: u64, pub language: String }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Action {
    Idle, Retained, Wait, Released(u64),
    Create { id: u64, generation: u64 },
    Show { id: u64, generation: u64 },
    Destroy { id: u64 },
}
#[derive(Clone, Debug)]
struct Closing {
    started: u64,
    last_attempt: Option<u64>,
    attempts: u8,
    destroyed: bool,
    // 精确 Destroyed 回执之后重新开始双表清理等待；不能沿用 builder/destroy 的起点。
    destroyed_at: Option<u64>,
    destroyed_probes: u8,
    // 超时/发送失败并不丢弃 owner；重新请求也只能重试同一个实例。
    uncertain: bool,
    retry: bool,
}
impl Closing {
    fn new(now: u64) -> Self {
        Self { started: now, last_attempt: None, attempts: 0, destroyed: false, destroyed_at: None, destroyed_probes: 0, uncertain: false, retry: true }
    }
}
#[derive(Clone, Debug)]
struct Instance { id: u64, language: String, closing: Option<Closing> }
#[derive(Default)]
pub(super) struct Model {
    generation: u64,
    next_instance: u64,
    terminal: bool,
    instance: Option<Instance>,
    building: Option<u64>,
    fatal: bool,
    // 原生 show/build 失败不得在没有新请求时无限重建。
    blocked: Option<u64>,
    // 只有 builder/native 尚未开始前的准备失败可恢复；副作用失败不设置此标记。
    recoverable_prebuild: bool,
}
impl Model {
    pub fn request(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(closing) = self.instance.as_mut().and_then(|i| i.closing.as_mut()) {
            closing.retry = true;
        }
    }
    pub fn terminate(&mut self) { if !self.terminal { self.terminal = true; self.request(); } }
    pub fn terminal(&self) -> bool { self.terminal }
    pub fn instance(&self) -> Option<u64> { self.instance.as_ref().map(|i| i.id).or(self.building) }
    pub fn closing(&self) -> bool { self.instance.as_ref().is_some_and(|i| i.closing.is_some()) }
    pub fn uncertain(&self) -> bool {
        self.fatal || self.instance.as_ref().and_then(|i| i.closing.as_ref()).is_some_and(|c| c.uncertain)
    }
    pub fn busy_resource(&self) -> bool { self.instance.is_some() || self.building.is_some() || self.fatal }
    pub fn can_show(&self, id: u64, generation: u64) -> bool {
        !self.terminal && !self.fatal && self.generation == generation
            && self.instance.as_ref().is_some_and(|i| i.id == id && i.closing.is_none())
    }
    pub fn can_create(&self, id: u64, generation: u64) -> bool {
        !self.terminal && !self.fatal && self.generation == generation && self.building == Some(id)
    }
    pub fn defer_creation(&mut self, id: u64) {
        if self.building == Some(id) { self.building = None; }
    }
    pub fn clear_recoverable_prebuild(&mut self) {
        self.recoverable_prebuild = false;
        self.blocked = None;
    }
    pub fn created(&mut self, id: u64, language: String) -> bool {
        if self.building != Some(id) || self.instance.is_some() { self.fatal = true; return false; }
        self.building = None;
        self.recoverable_prebuild = false;
        self.instance = Some(Instance { id, language, closing: None });
        true
    }
    pub fn creation_failed(&mut self, id: u64) {
        if self.building == Some(id) { self.fatal = true; self.recoverable_prebuild = false; self.blocked = Some(self.generation); }
    }
    // 只用于尚未调用 builder/native 的准备失败；不能拿它消除 build 返回后的未知副作用。
    pub fn cancel_creation(&mut self, id: u64) {
        if self.building == Some(id) { self.building = None; self.recoverable_prebuild = true; self.blocked = Some(self.generation); }
    }
    pub fn recoverable_prebuild_failure(&self) -> bool {
        self.recoverable_prebuild && self.instance.is_none() && self.building.is_none() && !self.fatal
    }
    pub fn native_failed(&mut self, id: u64, now: u64) {
        self.blocked = Some(self.generation);
        self.begin_close(id, now);
    }
    pub fn begin_close(&mut self, id: u64, now: u64) -> bool {
        let Some(instance) = self.instance.as_mut().filter(|i| i.id == id) else { return false; };
        if instance.closing.is_none() { instance.closing = Some(Closing::new(now)); }
        true
    }
    pub fn destroyed(&mut self, id: u64, now: u64) -> bool {
        if !self.begin_close(id, now) { return false; }
        let closing = self.instance.as_mut().unwrap().closing.as_mut().unwrap();
        if !closing.destroyed {
            closing.destroyed = true;
            closing.destroyed_at = Some(now);
            closing.destroyed_probes = 0;
        }
        closing.retry = true;
        true
    }
    pub fn queue_failed(&mut self, id: u64) {
        if let Some(closing) = self.instance.as_mut().filter(|i| i.id == id).and_then(|i| i.closing.as_mut()) {
            closing.uncertain = true;
        }
    }
    pub fn fault(&mut self) { self.fatal = true; self.blocked = Some(self.generation); }
    pub fn plan(&mut self, desired: &Desired, registry: Registry, now: u64) -> Action {
        if let Some(instance) = self.instance.as_mut() {
            if instance.closing.is_none() && (self.fatal || self.terminal || !desired.enabled || instance.language != desired.language) {
                instance.closing = Some(Closing::new(now));
            }
            if let Some(closing) = instance.closing.as_mut() {
                if closing.destroyed {
                    // 先前已经进入未知收尾时，晚到回执不能抹掉 fail-closed 状态。
                    if closing.uncertain { return Action::Retained; }
                    // 精确 Destroyed 回执 + Window/Webview 双表同时为空才释放。
                    // 如果最后一次有界探针已经观察到双表为空，可以安全收口；预算只限制
                    // 表仍未清空的等待，不把已确认的 Empty 误判成未知失败。
                    if registry == Registry::Empty {
                        let id = instance.id;
                        self.instance = None;
                        self.fatal = false;
                        return Action::Released(id);
                    }
                    // 探针预算耗尽且 manager 表仍有残留时，进入 sticky unknown；后续 Empty
                    // 也不能抹掉既有不确定性。
                    if closing.destroyed_probes >= MAX_CLOSE_RETRIES {
                        closing.uncertain = true;
                        return Action::Retained;
                    }
                    // Destroyed 可能晚于 WAIT_MS 才到达，也可能早于 manager 清表；
                    // 双表仍未空时按 250ms 有界复核，绝不提前释放 owner / Gate。
                    let since_ack = closing.destroyed_at.unwrap_or(now);
                    if now.saturating_sub(since_ack) >= RETRY_MS {
                        closing.destroyed_probes = closing.destroyed_probes.saturating_add(1);
                        closing.destroyed_at = Some(now);
                    }
                    return Action::Wait;
                }
                if matches!(registry, Registry::Other | Registry::Unavailable) {
                    closing.uncertain = true;
                    return Action::Retained;
                }
                // Destroy 请求尚无精确回执；不能仅凭标签空闲推断本实例已销毁。
                if closing.retry {
                    closing.retry = false;
                    closing.started = now;
                }
                if now.saturating_sub(closing.started) >= WAIT_MS || closing.attempts >= MAX_CLOSE_RETRIES {
                    closing.uncertain = true;
                    return Action::Retained;
                }
                if registry == Registry::Owned && closing.last_attempt.is_none_or(|last| now.saturating_sub(last) >= RETRY_MS) {
                    closing.attempts += 1;
                    closing.last_attempt = Some(now);
                    return Action::Destroy { id: instance.id };
                }
                return Action::Wait;
            }
            if registry != Registry::Owned { self.fatal = true; return Action::Retained; }
            return Action::Show { id: instance.id, generation: self.generation };
        }
        if self.fatal { return Action::Retained; }
        if self.building.is_some() { self.fatal = true; return Action::Retained; }
        if registry != Registry::Empty { self.fatal = true; return Action::Retained; }
        if self.terminal || !desired.enabled || self.blocked == Some(self.generation) { return Action::Idle; }
        let Some(id) = self.next_instance.checked_add(1) else { self.fatal = true; return Action::Retained; };
        self.next_instance = id;
        self.building = Some(id);
        Action::Create { id, generation: self.generation }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn desired(language: &str) -> Desired { Desired { enabled: true, revision: 1, language: language.into() } }
    fn live() -> (Model, u64) {
        let mut model = Model::default(); model.request();
        let Action::Create { id, .. } = model.plan(&desired("zh-CN"), Registry::Empty, 0) else { panic!() };
        assert!(model.created(id, "zh-CN".into())); (model, id)
    }
    #[test]
    fn queued_destroy_keeps_label_reserved_until_destroyed_and_both_registries_release() {
        let (mut model, id) = live(); model.request();
        assert_eq!(model.plan(&desired("en"), Registry::Owned, 0), Action::Destroy { id });
        assert_eq!(model.plan(&desired("en"), Registry::Owned, 1), Action::Wait);
        assert!(model.destroyed(id, 2));
        // 夹具明确分开 native 回执、window 表和 webview 表；不让 fake destroy 即刻释放标签。
        let event_before_cleanup = Registry::observe(true, true, true, true, None);
        assert_eq!(model.plan(&desired("en"), event_before_cleanup, 2), Action::Wait);
        let only_window_removed = Registry::observe(false, true, true, true, None);
        assert_eq!(model.plan(&desired("en"), only_window_removed, 2), Action::Wait);
        let only_webview_removed = Registry::observe(true, false, true, true, None);
        assert_eq!(model.plan(&desired("en"), only_webview_removed, 2), Action::Wait);
        let both_removed = Registry::observe(false, false, true, true, None);
        assert_eq!(model.plan(&desired("en"), both_removed, 3), Action::Released(id));
        assert!(matches!(model.plan(&desired("en"), Registry::Empty, 4), Action::Create { id: 2, .. }));
    }
    #[test]
    fn rapid_languages_and_disable_enable_rebuild_only_the_latest_desired_view() {
        let (mut model, id) = live();
        assert_eq!(model.plan(&desired("en"), Registry::Owned, 0), Action::Destroy { id });
        model.request(); let mut latest = desired("zh-TW"); latest.enabled = false;
        assert_eq!(model.plan(&latest, Registry::Owned, 1), Action::Wait);
        model.request(); latest.enabled = true;
        assert!(model.destroyed(id, 2));
        assert_eq!(model.plan(&latest, Registry::Empty, 3), Action::Released(id));
        let Action::Create { id: next, .. } = model.plan(&latest, Registry::Empty, 4) else { panic!() };
        assert!(model.created(next, latest.language.clone()));
        assert!(matches!(model.plan(&latest, Registry::Owned, 5), Action::Show { id: 2, .. }));
    }
    #[test]
    fn late_destroyed_receipt_gets_a_fresh_bounded_dual_registry_probe_window() {
        let (mut model, id) = live();
        assert_eq!(model.plan(&desired("en"), Registry::Owned, 0), Action::Destroy { id });
        // 精确回执晚于最初 close 起点；收到回执后仍须等待新的双表复核窗口。
        let ack = WAIT_MS + 10;
        assert!(model.destroyed(id, ack));
        assert_eq!(model.plan(&desired("en"), Registry::observe(true, true, true, true, None), ack), Action::Wait);
        assert_eq!(model.plan(&desired("en"), Registry::observe(false, true, true, true, None), ack + RETRY_MS - 1), Action::Wait);
        assert_eq!(model.plan(&desired("en"), Registry::observe(true, false, true, true, None), ack + RETRY_MS), Action::Wait);
        assert_eq!(model.plan(&desired("en"), Registry::Empty, ack + RETRY_MS * 2), Action::Released(id));
    }
    #[test]
    fn delayed_destroy_with_registry_still_present_exhausts_probes_without_releasing_owner() {
        let (mut model, id) = live();
        assert_eq!(model.plan(&desired("en"), Registry::Owned, 0), Action::Destroy { id });
        assert!(model.destroyed(id, 1));
        let mut now = 1;
        for _ in 0..MAX_CLOSE_RETRIES {
            now += RETRY_MS;
            assert_eq!(model.plan(&desired("en"), Registry::observe(true, true, true, true, None), now), Action::Wait);
        }
        assert!(matches!(model.plan(&desired("en"), Registry::observe(true, true, true, true, None), now + 1), Action::Retained));
        assert!(model.uncertain() && model.busy_resource());
        assert_eq!(model.plan(&desired("en"), Registry::Empty, now + 2), Action::Retained);
    }
    #[test]
    fn stale_destroyed_and_close_events_cannot_touch_a_replacement_instance() {
        let (mut model, old) = live(); model.destroyed(old, 0);
        assert_eq!(model.plan(&desired("en"), Registry::Empty, 1), Action::Released(old));
        let Action::Create { id, generation } = model.plan(&desired("en"), Registry::Empty, 2) else { panic!() };
        model.created(id, "en".into());
        assert!(!model.destroyed(old, 3)); assert!(!model.begin_close(old, 3));
        assert!(model.can_show(id, generation)); assert!(!model.closing());
    }
    #[test]
    fn terminal_close_invalidates_inflight_show_and_never_reopens() {
        let (mut model, id) = live();
        let Action::Show { generation, .. } = model.plan(&desired("zh-CN"), Registry::Owned, 0) else { panic!() };
        model.terminate(); model.terminate(); assert!(!model.can_show(id, generation));
        assert_eq!(model.plan(&desired("zh-CN"), Registry::Owned, 1), Action::Destroy { id });
        model.destroyed(id, 2);
        assert_eq!(model.plan(&desired("zh-CN"), Registry::Empty, 3), Action::Released(id));
        model.request(); assert_eq!(model.plan(&desired("en"), Registry::Empty, 4), Action::Idle);
    }
    #[test]
    fn prebuild_cancel_is_recoverable_but_native_creation_failure_is_not() {
        let mut model=Model::default();
        model.request();
        let Action::Create{id,..}=model.plan(&desired("en"),Registry::Empty,0) else {panic!()};
        model.cancel_creation(id);
        assert!(model.recoverable_prebuild_failure());
        assert_eq!(model.plan(&desired("en"),Registry::Empty,1),Action::Idle);
        model.clear_recoverable_prebuild();
        assert!(!model.recoverable_prebuild_failure());

        let mut failed=Model::default();
        failed.request();
        let Action::Create{id,..}=failed.plan(&desired("en"),Registry::Empty,0) else {panic!()};
        failed.creation_failed(id);
        assert!(!failed.recoverable_prebuild_failure());
        assert!(failed.uncertain());
        assert_eq!(failed.plan(&desired("en"),Registry::Empty,1),Action::Retained);
    }
    #[test]
    fn failed_queue_retries_only_exact_owner_with_finite_budget_and_retains_unknown() {
        let (mut model, id) = live(); model.terminate();
        // destroy 入队失败仍可对同一精确实例做有限重试；超出预算后保留 owner/Gate。
        for attempt in 0..MAX_CLOSE_RETRIES {
            let now = u64::from(attempt) * RETRY_MS;
            assert_eq!(model.plan(&desired("en"), Registry::Owned, now), Action::Destroy { id });
            model.queue_failed(id);
        }
        model.request();
        assert_eq!(model.plan(&desired("en"), Registry::Owned, 2_100), Action::Retained);
        assert!(model.uncertain() && model.busy_resource());
        // 晚到的精确回执不能抹掉之前的未知态，即使两张 manager 表都已空。
        assert!(model.destroyed(id, 2_101));
        assert_eq!(model.plan(&desired("en"), Registry::Empty, 2_102), Action::Retained);
        assert!(model.uncertain() && model.busy_resource());
    }
    #[test]
    fn missing_ack_is_not_gone_and_explicit_retry_does_not_clear_uncertainty() {
        let (mut model, id) = live();
        assert_eq!(model.plan(&desired("en"), Registry::Owned, 0), Action::Destroy { id });
        assert_eq!(model.plan(&desired("en"), Registry::Empty, WAIT_MS), Action::Retained);
        model.request();
        assert_eq!(model.plan(&desired("en"), Registry::Owned, WAIT_MS + 1), Action::Destroy { id });
        assert!(model.uncertain());
        assert_eq!(model.plan(&desired("en"), Registry::Other, WAIT_MS + 2), Action::Retained);
        assert!(!model.destroyed(id + 1, WAIT_MS + 3));
    }
    #[test]
    fn native_failure_cleans_owned_window_but_does_not_spin_rebuild_without_new_request() {
        let (mut model, id) = live(); model.native_failed(id, 0);
        assert_eq!(model.plan(&desired("zh-CN"), Registry::Owned, 1), Action::Destroy { id });
        model.destroyed(id, 2);
        assert_eq!(model.plan(&desired("zh-CN"), Registry::Empty, 3), Action::Released(id));
        assert_eq!(model.plan(&desired("zh-CN"), Registry::Empty, 4), Action::Idle);
        model.request(); assert!(matches!(model.plan(&desired("zh-CN"), Registry::Empty, 5), Action::Create { .. }));
    }
    #[test]
    fn failed_creation_or_unowned_label_never_turns_into_false_success() {
        let mut model = Model::default(); model.request();
        let Action::Create { id, .. } = model.plan(&desired("en"), Registry::Empty, 0) else { panic!() };
        model.creation_failed(id); model.request();
        assert_eq!(model.plan(&desired("en"), Registry::Empty, 1), Action::Retained);
        assert!(model.uncertain() && model.busy_resource());
        let mut other = Model::default();
        assert_eq!(other.plan(&desired("en"), Registry::Other, 0), Action::Retained);
    }
}