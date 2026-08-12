import type { CanopyIssue, ModuleHealth, SeedCard, StructureNode } from "./types";

export type Locale = "zh-TW" | "zh-CN" | "en";

type Messages = Record<string, string>;

const ZH_TW: Messages = {
  "brand.subtitle": "生命體系統",
  "brand.page_title": "Canopy 生命體系統",
  "loading.signals": "正在讀取生命訊號",
  "fatal.title": "Canopy 尚未連線",
  "common.retry": "重新檢查",
  "common.unreported": "未回報",
  "common.unspecified": "未指定",
  "common.unscheduled": "未排定",
  "common.no_summary": "尚未提供摘要。",
  "common.close": "關閉資訊",
  "status.healthy": "穩定",
  "status.attention": "留意",
  "status.critical": "需處理",
  "status.unknown": "待觀察",
  "nav.overview": "總覽",
  "nav.roots": "根系",
  "nav.structure": "內部",
  "nav.timeline": "歷程",
  "nav.refresh": "同步",
  "nav.sync_detail": "重新同步生命體並確認所有連接",
  "sync.completed": "已重新同步：{modules} 個生命單元、{connections} 條連接已確認",
  "nav.settings": "設定",
  "nav.bgm_on": "關閉背景音樂",
  "nav.bgm_off": "播放背景音樂",
  "hud.compact": "縮成精簡資訊",
  "hud.expand": "展開完整資訊",
  "hud.compact_short": "精簡",
  "hud.expand_short": "展開",
  "aria.scene": "Canopy 3D 生命體系統",
  "aria.navigation": "生命體系統導覽",
  "aria.health_legend": "健康狀態圖例",
  "aria.seed_cards": "Seed Memory 卡片",
  "aria.module_details": "生命單元詳情",
  "aria.card_details": "Seed 卡片詳情",
  "aria.structure_details": "Canopy 結構詳情",
  "aria.structure_navigation": "Canopy 結構導覽",
  "aria.activity_timeline": "Canopy 三十天活動歷程",
  "metric.structural": "結構",
  "metric.behavioral": "行為",
  "metric.health": "健康",
  "metric.activity": "活動",
  "metric.impact": "效益",
  "metric.evidence": "證據",
  "metric.active_cards": "啟用卡片",
  "metric.candidate_cards": "候選卡片",
  "metric.structural_score": "結構分數",
  "metric.miss_receipts": "未命中回條",
  "metric.open_misses": "待處理未命中",
  "metric.required_resolution_rate": "必要閉環完成率",
  "metric.observed_preflights": "已觀測前置處理",
  "metric.average_context_chars": "平均上下文字元",
  "metric.contract_version": "契約版本",
  "metric.routing_cases": "路由案例",
  "metric.runtime_chars": "執行契約字元",
  "metric.active": "啟用角色",
  "metric.deprecated": "已汰除角色",
  "metric.recent_selections": "近期角色選用",
  "metric.managed_bytes": "已管理容量",
  "metric.budget_bytes": "容量預算",
  "metric.pressure": "資源壓力",
  "metric.action_receipts": "行動回條",
  "metric.intake_receipts": "吸收回條",
  "metric.required_failures": "必要閉環失敗",
  "metric.recent_events_30d": "近 30 天活動",
  "dimension.recent_evidence": "有近期證據",
  "dimension.activity_30d": "近 30 天 {count} 筆活動",
  "dimension.no_activity_30d": "近 30 天沒有活動證據",
  "dimension.long_term_pending": "等待長期比較",
  "confidence.high": "高",
  "confidence.medium": "中",
  "confidence.low": "低",
  "confidence.unknown": "待觀察",
  "module.seed-memory.name": "Seed 記憶",
  "module.seed-memory.zone": "根系記憶區",
  "module.seed-memory.summary": "蒸餾操作者文化、偏好、教導與工具映射。",
  "module.brain.name": "Seed 大腦",
  "module.brain.zone": "判斷與學習中樞",
  "module.brain.summary": "負責語氣、吸收、未命中分析、行動回條與學習閉環。",
  "module.hooks.name": "前置／收尾閘門",
  "module.hooks.zone": "執行閘門",
  "module.hooks.summary": "每回合合成角色、Seed、意圖與閉環義務。",
  "module.evolution.name": "演化年輪",
  "module.evolution.zone": "演化回路",
  "module.evolution.summary": "把觀察轉為可逆、可驗證、可監測的 Canopy 改良。",
  "module.roles.name": "代理角色",
  "module.roles.zone": "能力分工區",
  "module.roles.summary": "只在領域文化、工具或驗證契約確實有增益時選用合適角色。",
  "module.resources.name": "資源循環",
  "module.resources.zone": "代謝與容量系統",
  "module.resources.summary": "管理本機資料成長、壓力、蒸餾、保留與可重建清理。",
  "module.receipts.name": "回條與監測",
  "module.receipts.zone": "證據與免疫系統",
  "module.receipts.summary": "保存命中、未命中、吸收與完成閉環的可查證證據。",
  "flow.section": "架構流向",
  "flow.incoming": "流入",
  "flow.outgoing": "流出",
  "flow.role_context": "角色能力注入",
  "flow.role_context_detail": "選出的 bounded 角色在前置處理提供領域與驗證能力。",
  "flow.memory_retrieval": "記憶召回",
  "flow.memory_retrieval_detail": "Seed 只送入與本次需求相符的操作者差異。",
  "flow.brain_decision": "判斷合成",
  "flow.brain_decision_detail": "大腦整合語氣、意圖、記憶與閉環義務。",
  "flow.execution_evidence": "執行證據",
  "flow.execution_evidence_detail": "Hook 將本回合命中與結果留下可驗證回條。",
  "flow.learning_feedback": "學習回饋",
  "flow.learning_feedback_detail": "回條把成功、失準與未命中送回大腦復盤。",
  "flow.memory_distillation": "記憶蒸餾",
  "flow.memory_distillation_detail": "大腦把可重用且有來源的操作者差異沉澱成 Seed。",
  "flow.monitoring_evidence": "監測證據",
  "flow.monitoring_evidence_detail": "長期回條為演化評估提供實際證據。",
  "flow.validated_change": "已驗證改良",
  "flow.validated_change_detail": "通過規範與測試的演化結果回到統一 Hook。",
  "flow.memory_resource_accounting": "記憶代謝",
  "flow.memory_resource_accounting_detail": "追蹤 Seed 的容量、複查、蒸餾與淘汰壓力。",
  "flow.runtime_resource_accounting": "執行成本",
  "flow.runtime_resource_accounting_detail": "追蹤每回合上下文與執行資源。",
  "flow.receipt_resource_accounting": "證據保存成本",
  "flow.receipt_resource_accounting_detail": "管理回條保留、壓縮與可重建清理。",
  "phase.preflight": "前置",
  "phase.postflight": "收尾",
  "phase.learning": "學習",
  "phase.evolution": "演化",
  "phase.maintenance": "代謝",
  "card.source": "來源",
  "card.scope": "範圍",
  "card.lifecycle": "生命週期",
  "card.review": "複查",
  "card.original_id": "原始識別碼",
  "card.search": "搜尋記憶、文化或觸發條件",
  "card.active_count": "顯示 {count} 張啟用卡片",
  "card.enter_roots": "進入根系記憶",
  "card.propose_change": "提出調整",
  "card.create": "新增記憶提案",
  "structure.enter": "探索內部結構",
  "structure.back": "上一層",
  "structure.back_to_overview": "返回 Canopy 總覽",
  "structure.root": "Canopy 宿主",
  "structure.tree": "成長古樹",
  "structure.path": "版本化路徑",
  "structure.children": "下層組成",
  "structure.dependencies": "依賴關係",
  "structure.size": "檔案大小",
  "structure.none": "沒有更多下層元件",
  "structure.kind.canopy": "保護邊界",
  "structure.kind.landmark": "成長主體",
  "structure.kind.organ": "生命單元",
  "structure.kind.system": "子系統",
  "structure.kind.tissue": "組織／資料夾",
  "structure.kind.component": "元件／檔案",
  "structure.child_count": "{count} 個下層",
  "structure.truncated": "已達公開導覽上限，僅顯示安全範圍內的節點。",
  "category.lessons": "經驗教導",
  "category.preferences": "操作者偏好",
  "category.capability_maps": "能力映射",
  "source.user_instruction": "使用者指示",
  "source.user_correction": "使用者導正",
  "source.user_teaching": "使用者教導",
  "source.tool_mapping": "工具映射",
  "source.project_culture": "專案文化",
  "source.seed_core": "Seed 核心",
  "source.unknown": "來源待確認",
  "lifecycle.active": "啟用",
  "lifecycle.candidate": "候選",
  "lifecycle.archived": "封存",
  "settings.title": "生命體系統設定",
  "settings.language": "畫面語言",
  "settings.background": "場景背景",
  "settings.background_detailed": "古樹遺跡",
  "settings.background_simple": "可愛冒險圖",
  "settings.background_none": "純淨模式",
  "settings.music": "自然音景",
  "settings.music_volume": "背景音量",
  "settings.music_credit": "目前曲目",
  "settings.sound_effects": "按鈕互動音",
  "settings.sound_effects_volume": "互動音量",
  "settings.sound_effects_on": "開啟",
  "settings.sound_effects_off": "關閉",
  "music.greenhouse": "古樹凱爾特",
  "music.meadow": "遺跡旅程",
  "music.forest": "月夜核心",
  "music.clear-sky": "溫暖歸途",
  "music.sunlit-piano": "晨光鋼琴",
  "music.sacred-grove": "神木之鈴",
  "music.resonant-chimes": "神鈴回響",
  "music.shrine-ritual": "古社祭儀",
  "music.ancient-temple": "遠古神殿",
  "settings.close": "關閉設定",
  "footer.back_greenhouse": "返回溫室",
  "footer.overview": "Canopy 總覽",
  "footer.no_major_issue": "目前沒有新的重大異常",
  "footer.issue_count": "{count} 項提醒",
  "audio.error": "瀏覽器無法啟動背景音樂",
  "treatment.eyebrow": "AI 調整請求",
  "treatment.title": "調整這段記憶",
  "treatment.create_title": "提出新的 Seed 記憶",
  "treatment.module_title": "提出生命單元改善方向",
  "treatment.close": "關閉",
  "treatment.no_direct_edit": "不直接修改原始 JSONL",
  "treatment.intent": "希望 AI 做什麼",
  "treatment.intent.update": "調整",
  "treatment.intent.create": "新增",
  "treatment.intent.merge": "合併",
  "treatment.intent.archive": "封存",
  "treatment.intent.diagnose": "診斷",
  "treatment.prompt": "用你的方式說明",
  "treatment.placeholder": "例如：這張卡片太容易在一般 UI 討論命中，請先分析原因，再提出更精準的範圍與負例測試。",
  "treatment.create_placeholder": "用自然語言描述你希望 Canopy 理解的習慣、教導或防再犯經驗。AI 會先判斷是否真的適合成為 Seed 卡片。",
  "treatment.module_placeholder": "先分析這個生命單元近期證據、失準原因與架構責任，再依 Canopy 演化規範提出可驗證的改善方案。",
  "treatment.guard": "AI 會先產生結構化差異、召回模擬與驗證項目；你確認後才可能交由 Canopy 套用。",
  "treatment.submit": "建立 AI 提案請求",
  "treatment.submitting": "建立中",
  "treatment.created": "已建立調整請求",
  "treatment.created_detail": "Canopy 生命體系統已保存結構化請求，但沒有直接修改 Canopy。你可以把交接內容帶到目前的 Codex 對話，讓 AI 依演化規範分析與產生差異。",
  "treatment.copy_codex": "複製給 Codex",
  "treatment.copied": "已複製交接內容",
  "treatment.done": "完成",
  "treatment.error": "無法建立提案",
  "issue.evidence_unavailable": "{source} 證據無法取得",
  "issue.seed_operator_issue": "Seed 有待確認項目",
  "issue.required_lifecycle_failures": "有 {count} 項必要閉環失敗",
  "module.propose_change": "提出生命單元改善",
  "activity.recent": "近期活動",
  "activity.no_recent": "近 30 天沒有可顯示的活動證據。",
  "activity.kind.turn": "回合執行",
  "activity.kind.task": "任務完成",
  "activity.kind.seed_action": "Seed 行動",
  "activity.kind.seed_intake": "記憶吸收",
  "activity.kind.miss_analysis": "未命中復盤",
  "activity.kind.tool": "AI 行動",
  "activity.kind.assistant_result": "AI 回覆",
  "activity.status.completed": "完成",
  "activity.status.applied": "已採用",
  "activity.status.active_card_created": "已建立啟用卡",
  "activity.status.candidate_card_created": "已建立候選卡",
  "activity.status.resolved": "已修正",
  "activity.status.open": "待處理",
  "activity.status.attention": "需留意",
  "activity.status.not_applied": "未採用",
  "activity.status.in_progress": "進行中",
  "activity.status.failed": "遇到問題",
  "activity.status.blocked": "保護中",
  "activity.status.interrupted": "已中止",
  "life.eyebrow": "你的 AI 助理",
  "life.title": "生命歷程",
  "life.open": "展開生命歷程",
  "life.close": "收合生命歷程",
  "life.current": "最新協助進度",
  "life.waiting": "正在等待下一個生命訊號。",
  "life.filter_label": "生命歷程篩選",
  "life.filter.all": "全部",
  "life.filter.growth": "成長",
  "life.filter.protection": "保護",
  "life.no_events": "生命歷程正在自動同步。",
  "life.no_filtered_events": "目前沒有這一類事件。",
  "life.learned": "這次我學到",
  "life.learning_status": "本回合學習判定",
  "life.learning.applied": "運用了既有理解",
  "life.learning.applied_detail": "Canopy 把已確認的理解交給 AI 使用；這不代表又新增一份長期記憶。",
  "life.learning.applied_next": "相似需求可少一次重複說明。",
  "life.learning.reviewed": "檢查後沒有硬套記憶",
  "life.learning.reviewed_detail": "Canopy 判斷既有理解不適合本次情境，因此沒有套用，也沒有新增記憶。",
  "life.learning.reviewed_next": "不相關的舊理解不會干擾這次需求。",
  "life.learning.reviewing": "正在判斷既有理解是否適用",
  "life.learning.reviewing_detail": "Canopy 已找到可能相關的理解；是否真的採用，要以同回合的 Seed 行動與收尾回條為準。",
  "life.learning.pending": "回合仍在進行",
  "life.learning.pending_detail": "完成後才會依可查回條判斷是否形成新學習；進行中不先宣稱學會。",
  "life.learning.incomplete": "這次沒有形成完成的學習",
  "life.learning.incomplete_detail": "回合被保護、中止或尚有缺漏，因此 Canopy 不把未完成結果當成已學會。",
  "life.learning.matched": "已找到相關的既有理解",
  "life.learning.matched_detail": "這筆回合證據顯示記憶曾被找到；是否實際採用，請看同回合的 Seed 行動。",
  "life.learning.none": "沒有形成新的長期記憶",
  "life.learning.none_detail": "完成工作不等於學習；這次沒有可驗證的 Seed 吸收或理解偏差修正紀錄。",
  "life.learning.miss_review": "正在復盤理解偏差",
  "life.learning.miss_review_detail": "Canopy 已察覺理解或路由可能有偏差；修正完成前不把它當成穩定學習。",
  "life.learning.evidence_unavailable": "已有吸收事件，但缺少可顯示內容",
  "life.learning.evidence_unavailable_detail": "Canopy 保留事件狀態，但不從其他摘要猜測學到什麼。",
  "life.next_time": "下次會更懂你：",
  "life.details": "這回合實際做了什麼",
  "life.focus_note": "同時聚焦對應生命部位",
  "life.helped": "實際幫了什麼",
  "life.request_effect": "Canopy 如何補足你的需求",
  "life.verified": "實際驗證",
  "life.turn_steps": "同回合 {count} 個可追溯步驟",
  "life.summary_unavailable": "本回合已完成，但這筆舊事件沒有可安全公開的成果摘要；請展開查看同回合步驟與驗證。",
  "life.fact.model": "模型",
  "life.fact.resolver_status": "記憶判定",
  "life.fact.matched_cards": "運用理解",
  "life.fact.role": "專業角色",
  "life.fact.evolution": "演化流程",
  "life.fact.intent_status": "需求銜接",
  "life.fact.context_chars": "補充脈絡",
  "life.fact.required_obligations": "必要驗證",
  "life.fact.missing_obligations": "缺漏證據",
  "life.open_calendar": "查看完整演化日曆",
  "life.retention": "已保存 {total} 筆 · 自動保留 {count} 天",
  "life.privacy": "顯示可稽核的有限摘要；不保存原始 prompt、hidden reasoning、secret、完整命令或工具輸出。",
  "life.sync.starting": "連接中",
  "life.sync.live": "即時同步",
  "life.sync.degraded": "稍後補齊",
  "life.phase.preparing": "理解與準備",
  "life.phase.running": "執行中",
  "life.phase.completed": "成果",
  "life.phase.growth": "成長回響",
  "life.phase.protection": "保護",
  "life.phase.observed": "活動",
  "life.stage.active": "已內化",
  "life.stage.candidate": "成長候選",
  "life.stage.applied": "已運用",
  "life.stage.resolved": "已修正",
  "life.stage.observed": "新觀察",
  "life.stage.reviewed": "未硬套",
  "life.stage.pending": "待完成",
  "life.stage.none": "無新增",
  "life.stage.incomplete": "未形成",
  "aria.life_stream": "AI 助理生命歷程",
  "timeline.eyebrow": "成長回放",
  "timeline.title": "30 天演化歷程",
  "timeline.previous": "前一天",
  "timeline.next": "後一天",
  "timeline.play": "播放成長歷程",
  "timeline.pause": "暫停成長歷程",
  "timeline.now": "回到現在",
  "timeline.days": "30 天活動強度",
  "timeline.event_count": "{count} 筆活動",
  "timeline.milestone_count": "{count} 個里程碑",
  "timeline.no_activity": "這一天沒有可顯示的活動證據。",
  "timeline.privacy": "只顯示有限摘要；不包含原始 prompt、來源摘錄、敏感資訊或本機絕對路徑。",
};

const ZH_CN: Messages = Object.fromEntries(
  Object.entries(ZH_TW).map(([key, value]) => [key, value
    .replaceAll("觀測", "观测")
    .replaceAll("記憶", "记忆")
    .replaceAll("學習", "学习")
    .replaceAll("處理", "处理")
    .replaceAll("連線", "连接")
    .replaceAll("結構", "结构")
    .replaceAll("行為", "行为")
    .replaceAll("啟用", "启用")
    .replaceAll("範圍", "范围")
    .replaceAll("生命週期", "生命周期")
    .replaceAll("複查", "复查")
    .replaceAll("調整", "调整")
    .replaceAll("導正", "纠正")
    .replaceAll("教導", "教导")
    .replaceAll("來源", "来源")
    .replaceAll("選用", "选用")
    .replaceAll("證據", "证据")
    .replaceAll("閉環", "闭环")
    .replaceAll("執行", "执行")
    .replaceAll("回條", "回执")
    .replaceAll("網頁", "网页")
    .replaceAll("瀏覽器", "浏览器")
    .replaceAll("檔", "文件")
    .replaceAll("設定", "设置")
    .replaceAll("音樂", "音乐")
    .replaceAll("遺跡", "遗迹")
    .replaceAll("歸途", "归途")
    .replaceAll("樹", "树")
    .replaceAll("爾", "尔")
    .replaceAll("鋼琴", "钢琴")
    .replaceAll("場景", "场景")
    .replaceAll("精緻", "精致")
    .replaceAll("溫室", "温室")
    .replaceAll("系統", "系统")
    .replaceAll("體", "体")
    .replaceAll("純淨", "纯净")
    .replaceAll("關閉", "关闭")
    .replaceAll("顯示", "显示")
    .replaceAll("觸發", "触发")
    .replaceAll("異常", "异常")
    .replaceAll("無法", "无法")
    .replaceAll("產生", "生成")
    .replaceAll("確認", "确认")
    .replaceAll("進入", "进入")
    .replaceAll("總覽", "总览")
    .replaceAll("選出的", "选出的")
    .replaceAll("實際", "实际")
    .replaceAll("儲", "存")
  ]),
);

const EN: Messages = {
  "brand.subtitle": "LIVING SYSTEM",
  "brand.page_title": "Canopy Living System",
  "loading.signals": "Reading life signals",
  "fatal.title": "Canopy is not connected",
  "common.retry": "Check again",
  "common.unreported": "Not reported",
  "common.unspecified": "Unspecified",
  "common.unscheduled": "Not scheduled",
  "common.no_summary": "No summary is available.",
  "common.close": "Close details",
  "status.healthy": "Stable",
  "status.attention": "Attention",
  "status.critical": "Action needed",
  "status.unknown": "Unobserved",
  "nav.overview": "Overview",
  "nav.roots": "Roots",
  "nav.structure": "Inside",
  "nav.timeline": "History",
  "nav.refresh": "Sync",
  "nav.sync_detail": "Re-sync the living system and verify every connection",
  "sync.completed": "Synced: {modules} living units and {connections} connections verified",
  "nav.settings": "Settings",
  "nav.bgm_on": "Mute background music",
  "nav.bgm_off": "Play background music",
  "hud.compact": "Compact this panel",
  "hud.expand": "Expand this panel",
  "hud.compact_short": "Compact",
  "hud.expand_short": "Expand",
  "aria.scene": "Canopy 3D living system",
  "aria.navigation": "Living system navigation",
  "aria.health_legend": "Health status legend",
  "aria.seed_cards": "Seed Memory cards",
  "aria.module_details": "Module details",
  "aria.card_details": "Seed card details",
  "aria.structure_details": "Canopy structure details",
  "aria.structure_navigation": "Canopy structure navigation",
  "aria.activity_timeline": "Canopy 30-day activity timeline",
  "metric.structural": "STRUCTURE",
  "metric.behavioral": "BEHAVIOR",
  "metric.health": "Health",
  "metric.activity": "Activity",
  "metric.impact": "Impact",
  "metric.evidence": "Evidence",
  "metric.active_cards": "Active cards",
  "metric.candidate_cards": "Candidate cards",
  "metric.structural_score": "Structural score",
  "metric.miss_receipts": "Miss receipts",
  "metric.open_misses": "Open misses",
  "metric.required_resolution_rate": "Required closure rate",
  "metric.observed_preflights": "Observed preflights",
  "metric.average_context_chars": "Average context chars",
  "metric.contract_version": "Contract version",
  "metric.routing_cases": "Routing cases",
  "metric.runtime_chars": "Runtime contract chars",
  "metric.active": "Active roles",
  "metric.deprecated": "Deprecated roles",
  "metric.recent_selections": "Recent role selections",
  "metric.managed_bytes": "Managed bytes",
  "metric.budget_bytes": "Capacity budget",
  "metric.pressure": "Resource pressure",
  "metric.action_receipts": "Action receipts",
  "metric.intake_receipts": "Intake receipts",
  "metric.required_failures": "Required closure failures",
  "metric.recent_events_30d": "30-day activity",
  "dimension.recent_evidence": "Recent evidence",
  "dimension.activity_30d": "{count} events in 30 days",
  "dimension.no_activity_30d": "No activity evidence in 30 days",
  "dimension.long_term_pending": "Awaiting long-term comparison",
  "confidence.high": "High",
  "confidence.medium": "Medium",
  "confidence.low": "Low",
  "confidence.unknown": "Unobserved",
  "module.seed-memory.name": "Seed Memory",
  "module.seed-memory.zone": "Memory roots",
  "module.seed-memory.summary": "Distills operator culture, preferences, teaching, and tool mappings.",
  "module.brain.name": "Seed Brain",
  "module.brain.zone": "Judgment and learning center",
  "module.brain.summary": "Handles tone, intake, miss analysis, action evidence, and learning loops.",
  "module.hooks.name": "Preflight / Postflight",
  "module.hooks.zone": "Execution gate",
  "module.hooks.summary": "Synthesizes roles, Seed context, intent, and closure obligations each turn.",
  "module.evolution.name": "Evolution Rings",
  "module.evolution.zone": "Evolution loop",
  "module.evolution.summary": "Turns observation into reversible, verified, and monitored Canopy improvements.",
  "module.roles.name": "Agent Roles",
  "module.roles.zone": "Capability delegation",
  "module.roles.summary": "Selects a role only when domain culture, tools, or verification contracts add value.",
  "module.resources.name": "Resource Circulation",
  "module.resources.zone": "Metabolism and capacity",
  "module.resources.summary": "Manages local growth, pressure, distillation, retention, and rebuildable cleanup.",
  "module.receipts.name": "Receipts & Monitoring",
  "module.receipts.zone": "Evidence and immune system",
  "module.receipts.summary": "Keeps verifiable evidence for retrievals, misses, intake, and completed loops.",
  "flow.section": "Architecture flows",
  "flow.incoming": "Incoming",
  "flow.outgoing": "Outgoing",
  "flow.role_context": "Role capability",
  "flow.role_context_detail": "The bounded role supplies domain and verification capability during preflight.",
  "flow.memory_retrieval": "Memory retrieval",
  "flow.memory_retrieval_detail": "Seed sends only operator differences relevant to the current request.",
  "flow.brain_decision": "Decision synthesis",
  "flow.brain_decision_detail": "Brain combines tone, intent, memory, and closure obligations.",
  "flow.execution_evidence": "Execution evidence",
  "flow.execution_evidence_detail": "Hooks leave verifiable evidence of retrievals and outcomes.",
  "flow.learning_feedback": "Learning feedback",
  "flow.learning_feedback_detail": "Receipts return success, drift, and misses to the Brain for review.",
  "flow.memory_distillation": "Memory distillation",
  "flow.memory_distillation_detail": "Brain distills reusable, sourced operator differences into Seed.",
  "flow.monitoring_evidence": "Monitoring evidence",
  "flow.monitoring_evidence_detail": "Long-term receipts provide evidence for evolution decisions.",
  "flow.validated_change": "Validated improvement",
  "flow.validated_change_detail": "Evolution changes that pass policy and tests return to the unified Hook.",
  "flow.memory_resource_accounting": "Memory metabolism",
  "flow.memory_resource_accounting_detail": "Tracks Seed capacity, review, distillation, and retention pressure.",
  "flow.runtime_resource_accounting": "Runtime cost",
  "flow.runtime_resource_accounting_detail": "Tracks per-turn context and execution resources.",
  "flow.receipt_resource_accounting": "Evidence storage cost",
  "flow.receipt_resource_accounting_detail": "Manages receipt retention, compression, and rebuildable cleanup.",
  "phase.preflight": "Preflight",
  "phase.postflight": "Postflight",
  "phase.learning": "Learning",
  "phase.evolution": "Evolution",
  "phase.maintenance": "Metabolism",
  "card.source": "Source",
  "card.scope": "Scope",
  "card.lifecycle": "Lifecycle",
  "card.review": "Review",
  "card.original_id": "Original ID",
  "card.search": "Search memory, culture, or triggers",
  "card.active_count": "Showing {count} active cards",
  "card.enter_roots": "Enter memory roots",
  "card.propose_change": "Propose adjustment",
  "card.create": "Propose new memory",
  "structure.enter": "Explore internal structure",
  "structure.back": "Up one level",
  "structure.back_to_overview": "Back to Canopy overview",
  "structure.root": "Canopy Host",
  "structure.tree": "Growth Tree",
  "structure.path": "Versioned path",
  "structure.children": "Contained parts",
  "structure.dependencies": "Dependencies",
  "structure.size": "File size",
  "structure.none": "No deeper component",
  "structure.kind.canopy": "Protection boundary",
  "structure.kind.landmark": "Growth body",
  "structure.kind.organ": "Living unit",
  "structure.kind.system": "Subsystem",
  "structure.kind.tissue": "Tissue / folder",
  "structure.kind.component": "Component / file",
  "structure.child_count": "{count} children",
  "structure.truncated": "The public navigation limit was reached; only safe bounded nodes are shown.",
  "category.lessons": "Lessons",
  "category.preferences": "Operator preferences",
  "category.capability_maps": "Capability maps",
  "source.user_instruction": "User instruction",
  "source.user_correction": "User correction",
  "source.user_teaching": "User teaching",
  "source.tool_mapping": "Tool mapping",
  "source.project_culture": "Project culture",
  "source.seed_core": "Seed core",
  "source.unknown": "Source unconfirmed",
  "lifecycle.active": "Active",
  "lifecycle.candidate": "Candidate",
  "lifecycle.archived": "Archived",
  "settings.title": "Living system settings",
  "settings.language": "Interface language",
  "settings.background": "Scene background",
  "settings.background_detailed": "Ancient tree ruins",
  "settings.background_simple": "Friendly adventure map",
  "settings.background_none": "Clean mode",
  "settings.music": "Nature soundscape",
  "settings.music_volume": "Music volume",
  "settings.music_credit": "Now playing",
  "settings.sound_effects": "Button sounds",
  "settings.sound_effects_volume": "Button volume",
  "settings.sound_effects_on": "On",
  "settings.sound_effects_off": "Off",
  "music.greenhouse": "Ancient-tree Celtic",
  "music.meadow": "Ruins journey",
  "music.forest": "Moonlit core",
  "music.clear-sky": "Warm homecoming",
  "music.sunlit-piano": "First-light piano",
  "music.sacred-grove": "Sacred grove bells",
  "music.resonant-chimes": "Resonant shrine bells",
  "music.shrine-ritual": "Shrine ritual",
  "music.ancient-temple": "Ancient temple",
  "settings.close": "Close settings",
  "footer.back_greenhouse": "Back to greenhouse",
  "footer.overview": "Canopy overview",
  "footer.no_major_issue": "No new major issue",
  "footer.issue_count": "{count} alerts",
  "audio.error": "The browser could not start background music",
  "treatment.eyebrow": "AI TREATMENT REQUEST",
  "treatment.title": "Adjust this memory",
  "treatment.create_title": "Propose new Seed memory",
  "treatment.module_title": "Propose a living-unit improvement",
  "treatment.close": "Close",
  "treatment.no_direct_edit": "Does not directly edit source JSONL",
  "treatment.intent": "What should AI do?",
  "treatment.intent.update": "Adjust",
  "treatment.intent.create": "Create",
  "treatment.intent.merge": "Merge",
  "treatment.intent.archive": "Archive",
  "treatment.intent.diagnose": "Diagnose",
  "treatment.prompt": "Describe it in your own words",
  "treatment.placeholder": "Example: this card is retrieved too broadly during ordinary UI discussions. Analyze why, then propose a narrower scope and negative regression cases.",
  "treatment.create_placeholder": "Describe the habit, teaching, or reusable lesson you want Canopy to understand. AI will first decide whether it belongs in Seed Memory.",
  "treatment.module_placeholder": "Analyze this living unit's recent evidence, failure causes, and ownership boundary, then propose a verifiable improvement under the Canopy evolution contract.",
  "treatment.guard": "AI first creates a structured diff, retrieval simulation, and validation plan. Canopy can apply it only after your confirmation.",
  "treatment.submit": "Create AI proposal request",
  "treatment.submitting": "Creating",
  "treatment.created": "Treatment request created",
  "treatment.created_detail": "Canopy Living System stored a structured request without changing Canopy. Copy the handoff into the current Codex task for analysis and a governed diff.",
  "treatment.copy_codex": "Copy for Codex",
  "treatment.copied": "Codex handoff copied",
  "treatment.done": "Done",
  "treatment.error": "Unable to create proposal",
  "issue.evidence_unavailable": "{source} evidence is unavailable",
  "issue.seed_operator_issue": "Seed has an item to review",
  "issue.required_lifecycle_failures": "{count} required closure failures",
  "module.propose_change": "Propose living-unit improvement",
  "activity.recent": "Recent activity",
  "activity.no_recent": "No bounded activity evidence is visible in the last 30 days.",
  "activity.kind.turn": "Turn execution",
  "activity.kind.task": "Task completion",
  "activity.kind.seed_action": "Seed action",
  "activity.kind.seed_intake": "Memory intake",
  "activity.kind.miss_analysis": "Miss review",
  "activity.kind.tool": "AI action",
  "activity.kind.assistant_result": "AI reply",
  "activity.status.completed": "Completed",
  "activity.status.applied": "Applied",
  "activity.status.active_card_created": "Active card created",
  "activity.status.candidate_card_created": "Candidate card created",
  "activity.status.resolved": "Resolved",
  "activity.status.open": "Open",
  "activity.status.attention": "Attention",
  "activity.status.not_applied": "Not applied",
  "activity.status.in_progress": "In progress",
  "activity.status.failed": "Needs attention",
  "activity.status.blocked": "Protecting",
  "activity.status.interrupted": "Interrupted",
  "life.eyebrow": "YOUR AI ASSISTANT",
  "life.title": "Life history",
  "life.open": "Open life history",
  "life.close": "Collapse life history",
  "life.current": "Latest assistance update",
  "life.waiting": "Waiting for the next life signal.",
  "life.filter_label": "Life history filters",
  "life.filter.all": "All",
  "life.filter.growth": "Growth",
  "life.filter.protection": "Protection",
  "life.no_events": "Life history is syncing automatically.",
  "life.no_filtered_events": "No events of this kind yet.",
  "life.learned": "What I learned",
  "life.learning_status": "Learning decision for this turn",
  "life.learning.applied": "Used an existing understanding",
  "life.learning.applied_detail": "Canopy gave the AI an already confirmed understanding. This does not create another long-term memory.",
  "life.learning.applied_next": "A similar request may need less repeated explanation.",
  "life.learning.reviewed": "Reviewed memory without forcing it",
  "life.learning.reviewed_detail": "Canopy determined that the existing understanding did not fit this situation, so it was neither applied nor saved again.",
  "life.learning.reviewed_next": "Unrelated prior understanding will not distort this request.",
  "life.learning.reviewing": "Checking whether an existing understanding applies",
  "life.learning.reviewing_detail": "Canopy found a potentially relevant understanding. The correlated Seed action and closure receipt determine whether it was actually used.",
  "life.learning.pending": "The turn is still in progress",
  "life.learning.pending_detail": "Canopy waits for auditable closure evidence before deciding whether learning occurred; it does not claim learning early.",
  "life.learning.incomplete": "No completed learning was formed",
  "life.learning.incomplete_detail": "The turn was protected, interrupted, or incomplete, so Canopy does not present the unfinished outcome as learned.",
  "life.learning.matched": "Found a relevant existing understanding",
  "life.learning.matched_detail": "This turn shows that memory was found. Check the correlated Seed action to see whether it was actually applied.",
  "life.learning.none": "No new long-term memory was formed",
  "life.learning.none_detail": "Completing work is not the same as learning. This turn has no verified Seed intake or corrected-understanding evidence.",
  "life.learning.miss_review": "Reviewing an understanding mismatch",
  "life.learning.miss_review_detail": "Canopy detected a possible understanding or routing mismatch. It is not presented as stable learning until the correction is complete.",
  "life.learning.evidence_unavailable": "An intake event exists without displayable content",
  "life.learning.evidence_unavailable_detail": "Canopy preserves the event state without guessing what was learned from another summary.",
  "life.next_time": "How this helps next time: ",
  "life.details": "What this turn actually did",
  "life.focus_note": "Also focuses the related living unit",
  "life.helped": "How it helped",
  "life.request_effect": "How Canopy completed your intent",
  "life.verified": "What was verified",
  "life.turn_steps": "{count} traceable steps in this turn",
  "life.summary_unavailable": "This turn completed, but this older event has no safely publishable outcome summary. Expand it to inspect the correlated steps and verification.",
  "life.fact.model": "Model",
  "life.fact.resolver_status": "Memory decision",
  "life.fact.matched_cards": "Applied understandings",
  "life.fact.role": "Professional role",
  "life.fact.evolution": "Evolution flow",
  "life.fact.intent_status": "Intent handoff",
  "life.fact.context_chars": "Added context",
  "life.fact.required_obligations": "Required checks",
  "life.fact.missing_obligations": "Missing evidence",
  "life.open_calendar": "Open the evolution calendar",
  "life.retention": "{total} saved · automatic {count}-day retention",
  "life.privacy": "Bounded auditable summaries only. Raw prompts, hidden reasoning, secrets, full commands, and tool output are not stored.",
  "life.sync.starting": "Connecting",
  "life.sync.live": "Live sync",
  "life.sync.degraded": "Will catch up",
  "life.phase.preparing": "Understanding",
  "life.phase.running": "Working",
  "life.phase.completed": "Outcome",
  "life.phase.growth": "Growth echo",
  "life.phase.protection": "Protection",
  "life.phase.observed": "Activity",
  "life.stage.active": "Internalized",
  "life.stage.candidate": "Growth candidate",
  "life.stage.applied": "Applied",
  "life.stage.resolved": "Corrected",
  "life.stage.observed": "New observation",
  "life.stage.reviewed": "Not forced",
  "life.stage.pending": "Pending closure",
  "life.stage.none": "No addition",
  "life.stage.incomplete": "Not formed",
  "aria.life_stream": "AI assistant life history",
  "timeline.eyebrow": "GROWTH REPLAY",
  "timeline.title": "30-day evolution history",
  "timeline.previous": "Previous day",
  "timeline.next": "Next day",
  "timeline.play": "Play growth history",
  "timeline.pause": "Pause growth history",
  "timeline.now": "Return to now",
  "timeline.days": "30-day activity intensity",
  "timeline.event_count": "{count} events",
  "timeline.milestone_count": "{count} milestones",
  "timeline.no_activity": "No visible activity evidence for this day.",
  "timeline.privacy": "Bounded summaries only. Raw prompts, source excerpts, sensitive values, and local absolute paths are excluded.",
};

const MESSAGES: Record<Locale, Messages> = { "zh-TW": ZH_TW, "zh-CN": ZH_CN, en: EN };

export function t(locale: Locale, key: string, params: Record<string, string | number> = {}): string {
  const template = MESSAGES[locale][key] ?? EN[key] ?? key;
  return Object.entries(params).reduce(
    (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
    template,
  );
}

export function moduleName(locale: Locale, moduleId: string, fallback = moduleId): string {
  const key = `module.${moduleId}.name`;
  const translated = t(locale, key);
  return translated === key ? fallback : translated;
}

export function moduleZone(locale: Locale, moduleId: string, fallback = moduleId): string {
  const key = `module.${moduleId}.zone`;
  const translated = t(locale, key);
  return translated === key ? fallback : translated;
}

export function moduleSummary(locale: Locale, module: ModuleHealth): string {
  const key = `module.${module.id}.summary`;
  const translated = t(locale, key);
  return translated === key ? module.summary : translated;
}

const STRUCTURE_NAME_KEYS: Record<string, string> = {
  "canopy-shell": "structure.root",
  "growth-tree": "structure.tree",
};

export function structureDisplayName(locale: Locale, node: StructureNode): string {
  const key = STRUCTURE_NAME_KEYS[node.id];
  if (key) return t(locale, key);
  if (node.id.startsWith("module:")) return moduleName(locale, node.module_id, node.name);
  return node.name;
}

export function structureKind(locale: Locale, node: StructureNode): string {
  return t(locale, `structure.kind.${node.kind}`);
}

export function metricLabel(locale: Locale, key: string): string {
  const translated = t(locale, `metric.${key}`);
  if (translated !== `metric.${key}`) return translated;
  return key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function localizedDimension(locale: Locale, value: string, kind: "activity" | "impact" | "confidence"): string {
  const normalized = value.trim().toLowerCase();
  const activityCount = value.match(/近 30 天\s*(\d+)\s*筆活動/);
  if (kind === "activity" && activityCount) {
    return t(locale, "dimension.activity_30d", { count: activityCount[1] });
  }
  if (kind === "activity" && value.includes("近 30 天沒有")) {
    return t(locale, "dimension.no_activity_30d");
  }
  if (kind === "activity" && (value.includes("近期") || normalized === "observed")) {
    return t(locale, "dimension.recent_evidence");
  }
  if (kind === "impact" && (value.includes("長期") || normalized === "observed")) {
    return t(locale, "dimension.long_term_pending");
  }
  if (kind === "confidence") {
    const level = ["high", "medium", "low"].includes(normalized) ? normalized : "unknown";
    return t(locale, `confidence.${level}`);
  }
  return value || t(locale, "common.unreported");
}

export function activityKind(locale: Locale, kind: string): string {
  const key = `activity.kind.${kind}`;
  const translated = t(locale, key);
  return translated === key ? kind.replaceAll("_", " ") : translated;
}

export function activityStatus(locale: Locale, status: string): string {
  const key = `activity.status.${status}`;
  const translated = t(locale, key);
  return translated === key ? status.replaceAll("_", " ") : translated;
}

const CARD_PHRASES: Record<Locale, Array<[RegExp, string]>> = {
  "zh-TW": [
    [/map_new_tools_to_habits/i, "讓新工具延續既有習慣"],
    [/architecture_consistency_before_new_files/i, "建立新檔前先確認架構一致性"],
    [/browser_visible_verification_gate/i, "在瀏覽器確認使用者看得到的結果"],
    [/use_matching_container_for_tests/i, "使用相符的執行環境進行測試"],
    [/learn_by_distillation/i, "透過蒸餾持續學習"],
    [/sms_test_number_ephemeral_only/i, "簡訊測試門號僅供一次性實機驗證"],
    [/shared_surface_pattern_before_special_case/i, "特例前先確認共用介面模式"],
    [/constraints_reusable_first/i, "優先整理成可重用的限制與方法"],
    [/local_channel_creation_gate/i, "建立專屬通道前先確認必要性"],
    [/humanized_ux_market_judgment/i, "兼顧人性化體驗與市場判斷"],
    [/prod_clickhouse_secret_profile/i, "ClickHouse 正式環境連線設定"],
    [/prod_mariadb_secret_profile_and_ck_mysql_compare/i, "MariaDB 正式環境連線與跨資料庫比對"],
    [/prod_taurus_innodb_readonly/i, "Taurus 正式環境唯讀資料檢查"],
  ],
  "zh-CN": [
    [/map_new_tools_to_habits/i, "让新工具延续既有习惯"],
    [/architecture_consistency_before_new_files/i, "建立新文件前先确认架构一致性"],
    [/browser_visible_verification_gate/i, "在浏览器确认用户看得到的结果"],
    [/use_matching_container_for_tests/i, "使用匹配的执行环境进行测试"],
    [/learn_by_distillation/i, "通过蒸馏持续学习"],
    [/sms_test_number_ephemeral_only/i, "短信测试号码仅供一次性真机验证"],
    [/shared_surface_pattern_before_special_case/i, "特例前先确认共用界面模式"],
    [/constraints_reusable_first/i, "优先整理成可复用的限制与方法"],
    [/local_channel_creation_gate/i, "建立专属通道前先确认必要性"],
    [/humanized_ux_market_judgment/i, "兼顾人性化体验与市场判断"],
    [/prod_clickhouse_secret_profile/i, "ClickHouse 正式环境连接设置"],
    [/prod_mariadb_secret_profile_and_ck_mysql_compare/i, "MariaDB 正式环境连接与跨数据库比对"],
    [/prod_taurus_innodb_readonly/i, "Taurus 正式环境只读数据检查"],
  ],
  en: [
    [/map_new_tools_to_habits/i, "Map new tools to existing habits"],
    [/architecture_consistency_before_new_files/i, "Check architecture consistency before adding files"],
    [/browser_visible_verification_gate/i, "Verify browser-visible outcomes"],
    [/use_matching_container_for_tests/i, "Use the matching runtime for tests"],
    [/learn_by_distillation/i, "Learn through distillation"],
    [/sms_test_number_ephemeral_only/i, "Use SMS test numbers only for one-time device checks"],
    [/shared_surface_pattern_before_special_case/i, "Check shared surface patterns before special cases"],
    [/constraints_reusable_first/i, "Prefer reusable constraints and methods"],
    [/local_channel_creation_gate/i, "Validate the need before creating a dedicated channel"],
    [/humanized_ux_market_judgment/i, "Balance humane UX with market judgment"],
    [/prod_clickhouse_secret_profile/i, "Production ClickHouse connection profile"],
    [/prod_mariadb_secret_profile_and_ck_mysql_compare/i, "Production MariaDB connection and cross-database comparison"],
    [/prod_taurus_innodb_readonly/i, "Production Taurus read-only data check"],
  ],
};

const TOKEN_LABELS: Record<Locale, Record<string, string>> = {
  "zh-TW": {
    capability: "能力", capabilities: "能力", lesson: "經驗", preference: "偏好", habit: "習慣",
    review: "審核", safety: "安全", workflow: "工作流程", judgment: "判斷", ui: "介面",
    payment: "付款", vendor: "廠商", project: "專案", local: "本機", seed: "Seed",
    readonly: "唯讀", profile: "設定", compare: "比對", production: "正式環境", prod: "正式環境",
  },
  "zh-CN": {
    capability: "能力", capabilities: "能力", lesson: "经验", preference: "偏好", habit: "习惯",
    review: "审核", safety: "安全", workflow: "工作流程", judgment: "判断", ui: "界面",
    payment: "付款", vendor: "厂商", project: "项目", local: "本机", seed: "Seed",
    readonly: "只读", profile: "设置", compare: "比对", production: "正式环境", prod: "正式环境",
  },
  en: {},
};

export function cardDisplayName(locale: Locale, card: SeedCard | string): string {
  const id = typeof card === "string" ? card : card.id;
  for (const [pattern, label] of CARD_PHRASES[locale]) {
    if (pattern.test(id)) return label;
  }
  const ignored = new Set(["local", "seed", "lesson", "project"]);
  const tokens = id.split(/[._-]+/).filter((token) => token && !ignored.has(token.toLowerCase()));
  if (locale === "en") {
    const text = tokens.join(" ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    return text || id;
  }
  return tokens.map((token) => TOKEN_LABELS[locale][token.toLowerCase()] ?? token.toUpperCase()).join(" · ") || id;
}

export function localizedCategory(locale: Locale, category: string): string {
  return t(locale, `category.${category}`);
}

export function localizedSource(locale: Locale, source: string): string {
  return t(locale, `source.${source}`);
}

export function localizedLifecycle(locale: Locale, lifecycle: string): string {
  return t(locale, `lifecycle.${lifecycle}`);
}

export function localizedIssueTitle(locale: Locale, issue: CanopyIssue): string {
  if (issue.code) {
    const params = Object.fromEntries(Object.entries(issue.params ?? {}).map(([key, value]) => [key, String(value)]));
    const translated = t(locale, `issue.${issue.code}`, params);
    if (translated !== `issue.${issue.code}`) return translated;
  }
  return issue.title;
}
