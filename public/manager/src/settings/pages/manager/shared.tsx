import type { ReactNode } from 'react';
import type { DashboardLocale, DashboardShortcutAction } from '../../../types';
import { SettingsKeyValue, StatusBadge, SettingsNote } from '../page-shell';
import type { DashboardActivityTitleSupport } from '../../../dashboard-settings/activity-title-support';
const LOCALE_OPTIONS = [
    { value: 'ko', label: '한국어 (ko)' },
    { value: 'en', label: 'English (en)' },
    { value: 'zh', label: '中文 (zh)' },
    { value: 'ja', label: '日本語 (ja)' },
] as const;

function normalizeDashboardLocale(input: unknown): DashboardLocale {
    const match = LOCALE_OPTIONS.find(option => option.value === input);
    return match?.value ?? 'ko';
}

const COPY = {
    ko: {
        ariaLabel: '대시보드 설정',
        eyebrow: '매니저 환경설정',
        title: '대시보드 설정',
        displayTitle: '인스턴스 목록 표시',
        displayDescription: '이 설정은 왼쪽 인스턴스 목록과 저장된 매니저 UI 환경설정에만 적용됩니다.',
        activityTitle: '미리보기와 활동',
        activityDescription: '최근 작업 제목은 각 인스턴스 서버의 endpoint 버전에 따라 달라집니다.',
        embeddingTitle: '임베딩 검색',
        embeddingDescription: '벡터 임베딩 provider를 설정하고 메모리 인덱스를 관리합니다.',
        fields: {
            activity: {
                label: '최근 작업 미리보기',
                scope: '왼쪽 인스턴스 목록',
                description: '요약 endpoint를 지원하는 인스턴스에서 최신 user 또는 assistant 메시지를 정리한 한 줄을 표시합니다.',
            },
            rename: {
                label: '이름 변경 컨트롤',
                scope: '왼쪽 인스턴스 목록',
                description: '대시보드 전용 인스턴스 이름을 편집하는 연필 버튼을 표시합니다.',
            },
            runtime: {
                label: '런타임 줄',
                scope: '왼쪽 인스턴스 목록',
                description: '각 인스턴스 이름 아래에 codex / gpt-5.5 같은 CLI와 모델 정보를 표시합니다.',
            },
            actions: {
                label: '확장 행 액션',
                scope: '선택된 인스턴스 행',
                description: '선택된 인스턴스 행에 Preview, Open, Start, Stop, Restart 버튼을 표시합니다.',
            },
            language: {
                label: '언어',
                scope: '전체 Jaw UI',
                description: 'i18n을 지원하는 매니저 대시보드 화면에 사용할 언어를 저장합니다.',
            },
            shortcuts: {
                label: '전역 단축키',
                scope: 'Manager dashboard',
                description: '입력창과 에디터 바깥에서만 작동하는 Manager 이동 단축키를 켭니다. Meta는 macOS에서 ⌘, Windows·Linux에서 Ctrl이고, Windows 키는 Win으로 적습니다.',
            },
            shortcutFocusInstances: {
                label: '인스턴스 목록',
                scope: '단축키',
                description: 'Instances workspace로 이동합니다.',
            },
            shortcutFocusActiveSession: {
                label: '활성 세션',
                scope: '단축키',
                description: '선택된 인스턴스의 Preview 탭으로 이동합니다.',
            },
            shortcutFocusNotes: {
                label: '노트',
                scope: '단축키',
                description: 'Notes workspace로 이동합니다.',
            },
            shortcutPreviousInstance: {
                label: '이전 인스턴스',
                scope: '단축키',
                description: '현재 필터 목록에서 이전 인스턴스를 선택합니다.',
            },
            shortcutToggleInstanceSettings: {
                label: '인스턴스 설정',
                scope: '단축키',
                description: '설정 패널을 열거나 닫습니다. 미리보기 iframe 안에서는 작동하지 않습니다.',
            },
            shortcutNextInstance: {
                label: '다음 인스턴스',
                scope: '단축키',
                description: '현재 필터 목록에서 다음 인스턴스를 선택합니다.',
            },
            shortcutResetSidebarWidth: {
                label: '사이드바 폭 리셋',
                scope: '단축키',
                description: '기본 300으로 되돌리고 \'jaw.sidebarWidth\' 키를 지운다.',
            },
            shortcutJumpInstance: {
                label: '인스턴스 점프',
                scope: '단축키',
                description: '렌더된 사이드바 행 1–9로 이동합니다. Meta+1–3는 탭 전환에 남아 있어 Alt를 씁니다.',
            },
            shortcutToggleBottomPanel: {
                label: '하단 패널',
                scope: '단축키',
                description: '하단 패널(터미널·활동)을 열거나 닫습니다.',
            },
            shortcutToggleRightPanel: {
                label: '오른쪽 사이드바',
                scope: '단축키',
                description: '오른쪽 패널을 열거나 닫고, 비어 있으면 파일 패널을 만듭니다.',
            },
            shortcutToggleLeftSidebar: {
                label: '왼쪽 사이드바',
                scope: '단축키',
                description: '왼쪽 인스턴스 사이드바를 접거나 펼칩니다.',
            },
            shortcutFocusTerminal: {
                label: '터미널 표시',
                scope: '단축키',
                description: '하단 터미널 탭을 열고 활성 터미널에 포커스합니다.',
            },
            shortcutNewTerminalSession: {
                label: '새 터미널 세션',
                scope: '단축키',
                description: '터미널 탭을 열고 새 셸 세션을 시작합니다.',
            },
            shortcutNewCodeSession: {
                label: '새 Code 세션',
                scope: '단축키',
                description: 'Code 모드 사이드바에서 새 세션 초안을 시작합니다.',
            },
            shortcutTerminalNewTab: {
                label: '새 터미널 탭',
                scope: '단축키',
                description: '새 터미널 세션을 엽니다.',
            },
            shortcutTerminalClear: {
                label: '터미널 지우기',
                scope: '단축키',
                description: '포커스된 터미널 버퍼를 지웁니다.',
            },
            shortcutOpenDiff: {
                label: 'Diff 패널',
                scope: '단축키',
                description: '오른쪽 diff 패널을 열거나 포커스합니다.',
            },
            shortcutOpenFolderTree: {
                label: '폴더 패널',
                scope: '단축키',
                description: '오른쪽 파일 트리 패널을 열거나 포커스합니다.',
            },
            shortcutCloseFocusedTab: {
                label: '포커스된 탭 닫기',
                scope: '단축키',
                description: '브라우저, 터미널, 패널 중 포커스된 탭을 닫습니다.',
            },
            shortcutSwitchTab1: {
                label: 'Overview 탭',
                scope: '단축키',
                description: '인스턴스 Overview 탭으로 전환합니다.',
            },
            shortcutSwitchTab2: {
                label: 'Preview 탭',
                scope: '단축키',
                description: '인스턴스 Preview 탭으로 전환합니다.',
            },
            shortcutSwitchTab3: {
                label: 'Logs 탭',
                scope: '단축키',
                description: '인스턴스 Logs 탭으로 전환합니다.',
            },
            shortcutPreviousTab: {
                label: '이전 탭',
                scope: '단축키',
                description: '이전 인스턴스 상세 탭으로 전환합니다.',
            },
            shortcutNextTab: {
                label: '다음 탭',
                scope: '단축키',
                description: '다음 인스턴스 상세 탭으로 전환합니다.',
            },
            shortcutBrowserReload: {
                label: '새로고침',
                scope: '단축키',
                description: '포커스 위치에 따라 브라우저, 프리뷰, 앱 창을 새로고침합니다.',
            },
            shortcutBrowserHardReload: {
                label: '강력 새로고침',
                scope: '단축키',
                description: '캐시를 무시하고 다시 로드합니다.',
            },
            shortcutBrowserFocusUrl: {
                label: 'URL 바 포커스',
                scope: '단축키',
                description: '브라우저 패널의 주소창에 포커스합니다.',
            },
            shortcutBrowserBack: {
                label: '브라우저 뒤로',
                scope: '단축키',
                description: '브라우저 패널에서 이전 페이지로 이동합니다.',
            },
            shortcutBrowserForward: {
                label: '브라우저 앞으로',
                scope: '단축키',
                description: '브라우저 패널에서 다음 페이지로 이동합니다.',
            },
        },
        support: {
            ariaLabel: '작업 제목 출처 준비 상태',
            ready: '준비됨',
            legacy: '레거시 endpoint',
            offline: '오프라인',
            empty: '현재 표시할 인스턴스가 없습니다.',
            restart: '최근 작업 제목을 사용하려면 레거시 인스턴스를 재시작하세요.',
        },
    },
    en: {
        ariaLabel: 'Dashboard settings',
        eyebrow: 'Manager preferences',
        title: 'Dashboard settings',
        displayTitle: 'Instance list display',
        displayDescription: 'These controls only affect the left instance list and saved manager UI preferences.',
        activityTitle: 'Preview & activity',
        activityDescription: 'Latest activity titles depend on each instance server endpoint version.',
        embeddingTitle: 'Embedding search',
        embeddingDescription: 'Configure a vector embedding provider and manage the memory index.',
        fields: {
            activity: {
                label: 'Recent activity preview',
                scope: 'Left instance list',
                description: 'Show one cleaned line from the latest user or assistant message when the instance supports the summary endpoint.',
            },
            rename: {
                label: 'Rename control',
                scope: 'Left instance list',
                description: 'Show the pencil button for editing the dashboard-only instance label.',
            },
            runtime: {
                label: 'Runtime line',
                scope: 'Left instance list',
                description: 'Show CLI and model text, for example codex / gpt-5.5, under each instance label.',
            },
            actions: {
                label: 'Expanded row actions',
                scope: 'Selected instance row',
                description: 'Show Preview, Open, Start, Stop, and Restart buttons on the selected instance row.',
            },
            language: {
                label: 'Language',
                scope: 'Global Jaw UI',
                description: 'Sets the saved manager dashboard locale for i18n-aware surfaces.',
            },
            shortcuts: {
                label: 'Global shortcuts',
                scope: 'Manager dashboard',
                description: 'Enable Manager navigation shortcuts outside inputs and editors. Meta means ⌘ on macOS and Ctrl on Windows/Linux; write Win for the Windows key.',
            },
            shortcutFocusInstances: {
                label: 'Instance list',
                scope: 'Shortcut',
                description: 'Move to the Instances workspace.',
            },
            shortcutFocusActiveSession: {
                label: 'Active session',
                scope: 'Shortcut',
                description: 'Move to the selected instance Preview tab.',
            },
            shortcutFocusNotes: {
                label: 'Notes',
                scope: 'Shortcut',
                description: 'Move to the Notes workspace.',
            },
            shortcutPreviousInstance: {
                label: 'Previous instance',
                scope: 'Shortcut',
                description: 'Select the previous instance in the current filtered list.',
            },
            shortcutToggleInstanceSettings: {
                label: 'Instance settings',
                scope: 'Shortcut',
                description: 'Open or close the settings panel in the Manager document; unavailable inside the preview iframe.',
            },
            shortcutNextInstance: {
                label: 'Next instance',
                scope: 'Shortcut',
                description: 'Select the next instance in the current filtered list.',
            },
            shortcutResetSidebarWidth: {
                label: 'Reset sidebar width',
                scope: 'Shortcut',
                description: 'Restore the default 300px width and delete the \'jaw.sidebarWidth\' key.',
            },
            shortcutJumpInstance: {
                label: 'Jump to instance',
                scope: 'Shortcut',
                description: 'Jump to rendered sidebar rows 1–9. Meta+1–3 stay on tab switching, so these use Alt.',
            },
            shortcutToggleBottomPanel: {
                label: 'Bottom panel',
                scope: 'Shortcut',
                description: 'Open or close the bottom panel (terminal and activity).',
            },
            shortcutToggleRightPanel: {
                label: 'Right sidebar',
                scope: 'Shortcut',
                description: 'Open or close the right panel; creates a files panel when empty.',
            },
            shortcutToggleLeftSidebar: {
                label: 'Left sidebar',
                scope: 'Shortcut',
                description: 'Collapse or expand the left instance sidebar.',
            },
            shortcutFocusTerminal: {
                label: 'Reveal terminal',
                scope: 'Shortcut',
                description: 'Open the bottom terminal tab and focus the active terminal.',
            },
            shortcutNewTerminalSession: {
                label: 'New terminal session',
                scope: 'Shortcut',
                description: 'Open the terminal tab and start a new shell session.',
            },
            shortcutNewCodeSession: {
                label: 'New Code session',
                scope: 'Shortcut',
                description: 'Start a new session draft in Code mode.',
            },
            shortcutTerminalNewTab: {
                label: 'New terminal tab',
                scope: 'Shortcut',
                description: 'Open a new terminal session.',
            },
            shortcutTerminalClear: {
                label: 'Clear terminal',
                scope: 'Shortcut',
                description: 'Clear the focused terminal buffer.',
            },
            shortcutOpenDiff: {
                label: 'Diff panel',
                scope: 'Shortcut',
                description: 'Open or focus the right diff panel.',
            },
            shortcutOpenFolderTree: {
                label: 'Folder panel',
                scope: 'Shortcut',
                description: 'Open or focus the right file tree panel.',
            },
            shortcutCloseFocusedTab: {
                label: 'Close focused tab',
                scope: 'Shortcut',
                description: 'Close the focused browser, terminal, or panel tab.',
            },
            shortcutSwitchTab1: {
                label: 'Overview tab',
                scope: 'Shortcut',
                description: 'Switch to the instance Overview tab.',
            },
            shortcutSwitchTab2: {
                label: 'Preview tab',
                scope: 'Shortcut',
                description: 'Switch to the instance Preview tab.',
            },
            shortcutSwitchTab3: {
                label: 'Logs tab',
                scope: 'Shortcut',
                description: 'Switch to the instance Logs tab.',
            },
            shortcutPreviousTab: {
                label: 'Previous tab',
                scope: 'Shortcut',
                description: 'Switch to the previous instance detail tab.',
            },
            shortcutNextTab: {
                label: 'Next tab',
                scope: 'Shortcut',
                description: 'Switch to the next instance detail tab.',
            },
            shortcutBrowserReload: {
                label: 'Reload',
                scope: 'Shortcut',
                description: 'Reload the browser, preview, or app window depending on focus.',
            },
            shortcutBrowserHardReload: {
                label: 'Hard reload',
                scope: 'Shortcut',
                description: 'Reload bypassing the cache.',
            },
            shortcutBrowserFocusUrl: {
                label: 'Focus URL bar',
                scope: 'Shortcut',
                description: 'Focus the address field in the browser panel.',
            },
            shortcutBrowserBack: {
                label: 'Browser back',
                scope: 'Shortcut',
                description: 'Navigate back in the browser panel.',
            },
            shortcutBrowserForward: {
                label: 'Browser forward',
                scope: 'Shortcut',
                description: 'Navigate forward in the browser panel.',
            },
        },
        support: {
            ariaLabel: 'Activity title source readiness',
            ready: 'Ready',
            legacy: 'Legacy endpoint',
            offline: 'Offline',
            empty: 'No instances are currently visible.',
            restart: 'Restart legacy instances to enable latest activity titles.',
        },
    },
    zh: {
        ariaLabel: '仪表盘设置',
        eyebrow: '管理器偏好',
        title: '仪表盘设置',
        displayTitle: '实例列表显示',
        displayDescription: '这些设置只影响左侧实例列表与已保存的管理器界面偏好。',
        activityTitle: '预览与活动',
        activityDescription: '最近活动标题取决于各实例服务器的 endpoint 版本。',
        embeddingTitle: '嵌入搜索',
        embeddingDescription: '向量嵌入 Provider 设置与内存索引管理。',
        fields: {
            activity: {
                label: '最近活动预览',
                scope: '左侧实例列表',
                description: '当实例支持摘要 endpoint 时，显示最近一条 user 或 assistant 消息整理后的单行内容。',
            },
            rename: {
                label: '重命名控件',
                scope: '左侧实例列表',
                description: '显示用于编辑仪表盘内实例标签的铅笔按钮。',
            },
            runtime: {
                label: '运行时信息行',
                scope: '左侧实例列表',
                description: '在每个实例标签下方显示 CLI 与模型信息，例如 codex / gpt-5.5。',
            },
            actions: {
                label: '展开行操作',
                scope: '已选中的实例行',
                description: '在已选中的实例行上显示 Preview、Open、Start、Stop、Restart 按钮。',
            },
            language: {
                label: '语言',
                scope: '整个 Jaw 界面',
                description: '为支持 i18n 的管理器仪表盘界面设置已保存的语言。',
            },
            shortcuts: {
                label: '全局快捷键',
                scope: 'Manager dashboard',
                description: '在输入框和编辑器外启用 Manager 导航快捷键。Meta 在 macOS 上是 ⌘，在 Windows/Linux 上是 Ctrl；Windows 键请写作 Win。',
            },
            shortcutFocusInstances: {
                label: '实例列表',
                scope: '快捷键',
                description: '切换到 Instances 工作区。',
            },
            shortcutFocusActiveSession: {
                label: '活动会话',
                scope: '快捷键',
                description: '切换到已选实例的 Preview 标签。',
            },
            shortcutFocusNotes: {
                label: 'Notes',
                scope: '快捷键',
                description: '切换到 Notes 工作区。',
            },
            shortcutPreviousInstance: {
                label: '上一个实例',
                scope: '快捷键',
                description: '选择当前筛选列表中的上一个实例。',
            },
            shortcutToggleInstanceSettings: {
                label: '实例设置',
                scope: '快捷键',
                description: '打开或关闭设置面板；在预览 iframe 内不可用。',
            },
            shortcutNextInstance: {
                label: '下一个实例',
                scope: '快捷键',
                description: '选择当前筛选列表中的下一个实例。',
            },
            shortcutResetSidebarWidth: {
                label: '重置侧边栏宽度',
                scope: '快捷键',
                description: '恢复默认 300px 宽度并删除 \'jaw.sidebarWidth\' 键。',
            },
            shortcutJumpInstance: {
                label: '跳转到实例',
                scope: '快捷键',
                description: '跳转到已渲染的侧边栏第 1–9 行。Meta+1–3 仍用于切换标签，因此这里使用 Alt。',
            },
            shortcutToggleBottomPanel: {
                label: '底部面板',
                scope: '快捷键',
                description: '打开或关闭底部面板（终端与活动）。',
            },
            shortcutToggleRightPanel: {
                label: '右侧栏',
                scope: '快捷键',
                description: '打开或关闭右侧面板；为空时创建文件面板。',
            },
            shortcutToggleLeftSidebar: {
                label: '左侧栏',
                scope: '快捷键',
                description: '折叠或展开左侧实例侧栏。',
            },
            shortcutFocusTerminal: {
                label: '显示终端',
                scope: '快捷键',
                description: '打开底部终端标签并聚焦活动终端。',
            },
            shortcutNewTerminalSession: {
                label: '新终端会话',
                scope: '快捷键',
                description: '打开终端标签并启动新的 Shell 会话。',
            },
            shortcutNewCodeSession: {
                label: '新 Code 会话',
                scope: '快捷键',
                description: '在 Code 模式侧边栏中开始新的会话草稿。',
            },
            shortcutTerminalNewTab: {
                label: '新终端标签',
                scope: '快捷键',
                description: '打开新的终端会话。',
            },
            shortcutTerminalClear: {
                label: '清空终端',
                scope: '快捷键',
                description: '清空当前聚焦的终端缓冲区。',
            },
            shortcutOpenDiff: {
                label: 'Diff 面板',
                scope: '快捷键',
                description: '打开或聚焦右侧 diff 面板。',
            },
            shortcutOpenFolderTree: {
                label: '文件夹面板',
                scope: '快捷键',
                description: '打开或聚焦右侧文件树面板。',
            },
            shortcutCloseFocusedTab: {
                label: '关闭焦点标签',
                scope: '快捷键',
                description: '关闭当前聚焦的浏览器、终端或面板标签。',
            },
            shortcutSwitchTab1: {
                label: 'Overview 标签',
                scope: '快捷键',
                description: '切换到实例 Overview 标签。',
            },
            shortcutSwitchTab2: {
                label: 'Preview 标签',
                scope: '快捷键',
                description: '切换到实例 Preview 标签。',
            },
            shortcutSwitchTab3: {
                label: 'Logs 标签',
                scope: '快捷键',
                description: '切换到实例 Logs 标签。',
            },
            shortcutPreviousTab: {
                label: '上一个标签',
                scope: '快捷键',
                description: '切换到上一个实例详情标签。',
            },
            shortcutNextTab: {
                label: '下一个标签',
                scope: '快捷键',
                description: '切换到下一个实例详情标签。',
            },
            shortcutBrowserReload: {
                label: '重新加载',
                scope: '快捷键',
                description: '根据焦点位置重新加载浏览器、预览或应用窗口。',
            },
            shortcutBrowserHardReload: {
                label: '强制重新加载',
                scope: '快捷键',
                description: '忽略缓存重新加载。',
            },
            shortcutBrowserFocusUrl: {
                label: '聚焦 URL 栏',
                scope: '快捷键',
                description: '聚焦浏览器面板的地址栏。',
            },
            shortcutBrowserBack: {
                label: '浏览器后退',
                scope: '快捷键',
                description: '在浏览器面板中后退一页。',
            },
            shortcutBrowserForward: {
                label: '浏览器前进',
                scope: '快捷键',
                description: '在浏览器面板中前进一页。',
            },
        },
        support: {
            ariaLabel: '活动标题来源就绪状态',
            ready: '就绪',
            legacy: '旧版 endpoint',
            offline: '离线',
            empty: '当前没有可显示的实例。',
            restart: '请重启旧版实例以启用最近活动标题。',
        },
    },
    ja: {
        ariaLabel: 'ダッシュボード設定',
        eyebrow: 'マネージャー環境設定',
        title: 'ダッシュボード設定',
        displayTitle: 'インスタンス一覧の表示',
        displayDescription: 'これらの設定は左側のインスタンス一覧と保存済みのマネージャー UI 設定にのみ反映されます。',
        activityTitle: 'プレビューとアクティビティ',
        activityDescription: '最近のアクティビティタイトルは各インスタンスサーバーの endpoint バージョンによって変わります。',
        embeddingTitle: 'エンベディング検索',
        embeddingDescription: 'ベクトルエンベディング Provider の設定とメモリインデックスの管理。',
        fields: {
            activity: {
                label: '最近のアクティビティのプレビュー',
                scope: '左側のインスタンス一覧',
                description: 'サマリ endpoint をサポートするインスタンスでは、直近の user または assistant メッセージを整形した 1 行を表示します。',
            },
            rename: {
                label: '名前変更コントロール',
                scope: '左側のインスタンス一覧',
                description: 'ダッシュボード専用のインスタンス表示名を編集する鉛筆ボタンを表示します。',
            },
            runtime: {
                label: 'ランタイム行',
                scope: '左側のインスタンス一覧',
                description: '各インスタンス名の下に codex / gpt-5.5 のような CLI とモデル情報を表示します。',
            },
            actions: {
                label: '展開行アクション',
                scope: '選択中のインスタンス行',
                description: '選択中のインスタンス行に Preview、Open、Start、Stop、Restart のボタンを表示します。',
            },
            language: {
                label: '言語',
                scope: 'Jaw UI 全体',
                description: 'i18n 対応のマネージャーダッシュボード画面で使用する言語を保存します。',
            },
            shortcuts: {
                label: 'グローバルショートカット',
                scope: 'Manager dashboard',
                description: '入力欄とエディタ外で Manager ナビゲーションショートカットを有効にします。Meta は macOS では ⌘、Windows/Linux では Ctrl です。Windows キーは Win と書きます。',
            },
            shortcutFocusInstances: {
                label: 'インスタンス一覧',
                scope: 'ショートカット',
                description: 'Instances ワークスペースへ移動します。',
            },
            shortcutFocusActiveSession: {
                label: 'アクティブセッション',
                scope: 'ショートカット',
                description: '選択中インスタンスの Preview タブへ移動します。',
            },
            shortcutFocusNotes: {
                label: 'Notes',
                scope: 'ショートカット',
                description: 'Notes ワークスペースへ移動します。',
            },
            shortcutPreviousInstance: {
                label: '前のインスタンス',
                scope: 'ショートカット',
                description: '現在のフィルタ一覧で前のインスタンスを選択します。',
            },
            shortcutToggleInstanceSettings: {
                label: 'インスタンス設定',
                scope: 'ショートカット',
                description: '設定パネルを開閉します。プレビュー iframe 内では使えません。',
            },
            shortcutNextInstance: {
                label: '次のインスタンス',
                scope: 'ショートカット',
                description: '現在のフィルタ一覧で次のインスタンスを選択します。',
            },
            shortcutResetSidebarWidth: {
                label: 'サイドバー幅をリセット',
                scope: 'ショートカット',
                description: '既定の 300px に戻し、\'jaw.sidebarWidth\' キーを削除します。',
            },
            shortcutJumpInstance: {
                label: 'インスタンスへジャンプ',
                scope: 'ショートカット',
                description: '描画済みサイドバー行 1–9 へ移動します。Meta+1–3 はタブ切替のままなので Alt を使います。',
            },
            shortcutToggleBottomPanel: {
                label: 'ボトムパネル',
                scope: 'ショートカット',
                description: 'ボトムパネル（ターミナル・アクティビティ）を開閉します。',
            },
            shortcutToggleRightPanel: {
                label: '右サイドバー',
                scope: 'ショートカット',
                description: '右パネルを開閉し、空の場合はファイルパネルを作成します。',
            },
            shortcutToggleLeftSidebar: {
                label: '左サイドバー',
                scope: 'ショートカット',
                description: '左のインスタンスサイドバーを折りたたみ/展開します。',
            },
            shortcutFocusTerminal: {
                label: 'ターミナルを表示',
                scope: 'ショートカット',
                description: 'ボトムのターミナルタブを開き、アクティブなターミナルにフォーカスします。',
            },
            shortcutNewTerminalSession: {
                label: '新しいターミナルセッション',
                scope: 'ショートカット',
                description: 'ターミナルタブを開き、新しいシェルセッションを開始します。',
            },
            shortcutNewCodeSession: {
                label: '新しい Code セッション',
                scope: 'ショートカット',
                description: 'Code モードのサイドバーで新しいセッションの下書きを開始します。',
            },
            shortcutTerminalNewTab: {
                label: '新しいターミナルタブ',
                scope: 'ショートカット',
                description: '新しいターミナルセッションを開きます。',
            },
            shortcutTerminalClear: {
                label: 'ターミナルをクリア',
                scope: 'ショートカット',
                description: 'フォーカス中のターミナルバッファをクリアします。',
            },
            shortcutOpenDiff: {
                label: 'Diff パネル',
                scope: 'ショートカット',
                description: '右の diff パネルを開くかフォーカスします。',
            },
            shortcutOpenFolderTree: {
                label: 'フォルダーパネル',
                scope: 'ショートカット',
                description: '右のファイルツリーパネルを開くかフォーカスします。',
            },
            shortcutCloseFocusedTab: {
                label: 'フォーカス中のタブを閉じる',
                scope: 'ショートカット',
                description: 'フォーカスされているブラウザ、ターミナル、パネルのタブを閉じます。',
            },
            shortcutSwitchTab1: {
                label: 'Overview タブ',
                scope: 'ショートカット',
                description: 'インスタンスの Overview タブに切り替えます。',
            },
            shortcutSwitchTab2: {
                label: 'Preview タブ',
                scope: 'ショートカット',
                description: 'インスタンスの Preview タブに切り替えます。',
            },
            shortcutSwitchTab3: {
                label: 'Logs タブ',
                scope: 'ショートカット',
                description: 'インスタンスの Logs タブに切り替えます。',
            },
            shortcutPreviousTab: {
                label: '前のタブ',
                scope: 'ショートカット',
                description: '前のインスタンス詳細タブに切り替えます。',
            },
            shortcutNextTab: {
                label: '次のタブ',
                scope: 'ショートカット',
                description: '次のインスタンス詳細タブに切り替えます。',
            },
            shortcutBrowserReload: {
                label: '再読み込み',
                scope: 'ショートカット',
                description: 'フォーカス位置に応じてブラウザ、プレビュー、アプリウィンドウを再読み込みします。',
            },
            shortcutBrowserHardReload: {
                label: '強制再読み込み',
                scope: 'ショートカット',
                description: 'キャッシュを無視して再読み込みします。',
            },
            shortcutBrowserFocusUrl: {
                label: 'URL バーにフォーカス',
                scope: 'ショートカット',
                description: 'ブラウザパネルのアドレスバーにフォーカスします。',
            },
            shortcutBrowserBack: {
                label: 'ブラウザの戻る',
                scope: 'ショートカット',
                description: 'ブラウザパネルで前のページに戻ります。',
            },
            shortcutBrowserForward: {
                label: 'ブラウザの進む',
                scope: 'ショートカット',
                description: 'ブラウザパネルで次のページに進みます。',
            },
        },
        support: {
            ariaLabel: 'アクティビティタイトル取得元の準備状態',
            ready: '準備完了',
            legacy: '旧 endpoint',
            offline: 'オフライン',
            empty: '現在表示できるインスタンスはありません。',
            restart: '最新のアクティビティタイトルを使うには、旧バージョンのインスタンスを再起動してください。',
        },
    },
} as const;

type DashboardSettingRowProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    children: ReactNode;
};

function DashboardSettingRow(props: DashboardSettingRowProps) {
    return (
        <label className="settings-field" htmlFor={props.id}>
            <span className="settings-field-label">{props.label}</span>
            {props.children}
            <span className="settings-field-description">
                <span className="dashboard-settings-row-scope">{props.scope}</span>{' '}
                {props.description}
            </span>
        </label>
    );
}

type DashboardSettingToggleProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    value: boolean;
    onChange: (value: boolean) => void;
};

function DashboardSettingToggle(props: DashboardSettingToggleProps) {
    return (
        <DashboardSettingRow id={props.id} label={props.label} scope={props.scope} description={props.description}>
            <input
                id={props.id}
                type="checkbox"
                checked={props.value}
                onChange={(event) => props.onChange(event.currentTarget.checked)}
            />
        </DashboardSettingRow>
    );
}

type DashboardSettingSelectProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    value: DashboardLocale;
    options: readonly { value: DashboardLocale; label: string }[];
    onChange: (value: DashboardLocale) => void;
};

type DashboardShortcutInputProps = {
    action: DashboardShortcutAction;
    label: string;
    scope: string;
    description: string;
    value: string;
    onChange: (action: DashboardShortcutAction, value: string) => void;
};

function DashboardSettingSelect(props: DashboardSettingSelectProps) {
    return (
        <DashboardSettingRow id={props.id} label={props.label} scope={props.scope} description={props.description}>
            <select
                id={props.id}
                value={props.value}
                onChange={(event) => props.onChange(normalizeDashboardLocale(event.currentTarget.value))}
            >
                {props.options.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </DashboardSettingRow>
    );
}

function DashboardShortcutInput(props: DashboardShortcutInputProps) {
    return (
        <DashboardSettingRow id={`dashboard-shortcut-${props.action}`} label={props.label} scope={props.scope} description={props.description}>
            <input
                id={`dashboard-shortcut-${props.action}`}
                type="text"
                className="dashboard-settings-shortcut-input"
                value={props.value}
                aria-label={`${props.label} shortcut`}
                placeholder="Alt+I"
                onChange={(event) => props.onChange(props.action, event.currentTarget.value)}
            />
        </DashboardSettingRow>
    );
}

const SHORTCUT_COPY_KEYS: Record<DashboardShortcutAction, keyof typeof COPY.ko.fields> = {
    toggleInstanceSettings: 'shortcutToggleInstanceSettings',
    focusInstances: 'shortcutFocusInstances',
    focusActiveSession: 'shortcutFocusActiveSession',
    focusNotes: 'shortcutFocusNotes',
    previousInstance: 'shortcutPreviousInstance',
    nextInstance: 'shortcutNextInstance',
    toggleBottomPanel: 'shortcutToggleBottomPanel',
    toggleRightPanel: 'shortcutToggleRightPanel',
    toggleLeftSidebar: 'shortcutToggleLeftSidebar',
    focusTerminal: 'shortcutFocusTerminal',
    newTerminalSession: 'shortcutNewTerminalSession',
    newCodeSession: 'shortcutNewCodeSession',
    terminalNewTab: 'shortcutTerminalNewTab',
    terminalClear: 'shortcutTerminalClear',
    openDiff: 'shortcutOpenDiff',
    openFolderTree: 'shortcutOpenFolderTree',
    closeFocusedTab: 'shortcutCloseFocusedTab',
    switchTab1: 'shortcutSwitchTab1',
    switchTab2: 'shortcutSwitchTab2',
    switchTab3: 'shortcutSwitchTab3',
    previousTab: 'shortcutPreviousTab',
    nextTab: 'shortcutNextTab',
    browserReload: 'shortcutBrowserReload',
    browserHardReload: 'shortcutBrowserHardReload',
    browserFocusUrl: 'shortcutBrowserFocusUrl',
    browserBack: 'shortcutBrowserBack',
    browserForward: 'shortcutBrowserForward',
    resetSidebarWidth: 'shortcutResetSidebarWidth',
    jumpInstance1: 'shortcutJumpInstance',
    jumpInstance2: 'shortcutJumpInstance',
    jumpInstance3: 'shortcutJumpInstance',
    jumpInstance4: 'shortcutJumpInstance',
    jumpInstance5: 'shortcutJumpInstance',
    jumpInstance6: 'shortcutJumpInstance',
    jumpInstance7: 'shortcutJumpInstance',
    jumpInstance8: 'shortcutJumpInstance',
    jumpInstance9: 'shortcutJumpInstance',
};

function shortcutCopyKey(action: DashboardShortcutAction): keyof typeof COPY.ko.fields {
    return SHORTCUT_COPY_KEYS[action];
}

function TitleSupportSummary({ support, locale }: { support: DashboardActivityTitleSupport; locale: DashboardLocale }) {
    const total = support.ready + support.legacy + support.offline;
    const copy = COPY[locale].support;
    return (
        <div role="group" aria-label={copy.ariaLabel}>
            <SettingsKeyValue
                items={[
                    { label: copy.ready, value: <StatusBadge tone="ok">{support.ready}</StatusBadge> },
                    { label: copy.legacy, value: <StatusBadge tone="warn">{support.legacy}</StatusBadge> },
                    { label: copy.offline, value: <StatusBadge tone="neutral">{support.offline}</StatusBadge> },
                ]}
            />
            <SettingsNote>{total === 0 ? copy.empty : copy.restart}</SettingsNote>
        </div>
    );
}


export { COPY, LOCALE_OPTIONS, normalizeDashboardLocale, DashboardSettingToggle, DashboardSettingSelect, DashboardShortcutInput, shortcutCopyKey, TitleSupportSummary };
