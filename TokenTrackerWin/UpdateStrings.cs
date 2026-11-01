namespace TokenTrackerWin;

/// <summary>
/// Localized strings for the "check for updates" tray flow, mirroring the
/// <see cref="TrayStrings"/> per-locale pattern. Kept separate so the (already
/// long) positional <see cref="TrayStrings"/> record stays focused on the core
/// menu. Format placeholders: <c>{0}</c> = version, and for
/// <see cref="UpToDateMessage"/> the current version.
/// </summary>
internal sealed record UpdateStrings(
    string CheckForUpdates,
    string Checking,
    string UpdateNow,          // "{0}" = new version
    string Downloading,        // "{0}" = percent
    string Installing,
    string UpToDateTitle,
    string UpToDateMessage,    // "{0}" = current version
    string UpdateFoundTitle,
    string UpdateFoundPrompt,  // "{0}" = new version, "{1}" = current version
    string ErrorTitle,
    string ErrorMessage,
    string OpenReleasePagePrompt,
    string ApiRetryAtMessage,  // "{0}" = local date/time, only when reported by GitHub
    string IntegrityErrorTitle,
    string IntegrityErrorMessage,
    string NewVersionBalloon)  // "{0}" = new version
{
    public static UpdateStrings For(string locale)
    {
        return locale switch
        {
            NativeLocalization.ChineseLocale => new(
                "检查更新",
                "正在检查更新…",
                "更新到 {0}",
                "正在下载 {0}%",
                "正在安装更新…",
                "已是最新版本",
                "你正在使用最新版本（{0}）。",
                "发现新版本",
                "新版本 {0} 可用（当前 {1}）。现在更新吗？",
                "暂时无法检查更新",
                "本次未能获取最新版本，请稍后重试。\n你也可以打开官方发布页，尝试手动下载。",
                "是否现在打开官方发布页？",
                "GitHub 接口可重试时间：{0}",
                "更新文件校验失败",
                "下载的安装包与官方校验值不符，已删除且未安装。请稍后重试或前往 GitHub 手动下载。",
                "新版本 {0} 可用，点击托盘菜单「更新」即可升级。"),
            NativeLocalization.TraditionalChineseLocale => new(
                "檢查更新",
                "正在檢查更新…",
                "更新到 {0}",
                "正在下載 {0}%",
                "正在安裝更新…",
                "已是最新版本",
                "你正在使用最新版本（{0}）。",
                "發現新版本",
                "新版本 {0} 可用（目前 {1}）。現在更新嗎？",
                "暫時無法檢查更新",
                "本次未能取得最新版本，請稍後重試。\n你也可以開啟官方發佈頁，嘗試手動下載。",
                "是否現在開啟官方發佈頁？",
                "GitHub 介面可重試時間：{0}",
                "更新檔案校驗失敗",
                "下載的安裝檔與官方校驗值不符，已刪除且未安裝。請稍後重試或前往 GitHub 手動下載。",
                "新版本 {0} 可用，點擊系統匣選單「更新」即可升級。"),
            NativeLocalization.JapaneseLocale => new(
                "アップデートを確認",
                "アップデートを確認中…",
                "{0} に更新",
                "ダウンロード中 {0}%",
                "アップデートをインストール中…",
                "最新バージョンです",
                "最新バージョン（{0}）を使用しています。",
                "新しいバージョン",
                "新しいバージョン {0} が利用可能です（現在 {1}）。今すぐ更新しますか？",
                "現在アップデートを確認できません",
                "最新バージョンを取得できませんでした。しばらくしてから再度お試しください。\n公式リリースページから手動でダウンロードすることもできます。",
                "公式リリースページを開きますか？",
                "GitHub API の再試行可能日時：{0}",
                "更新ファイルの検証に失敗",
                "ダウンロードしたインストーラーが公式のチェックサムと一致しません。削除し、インストールは行いませんでした。後でもう一度試すか、GitHub から手動でダウンロードしてください。",
                "新しいバージョン {0} が利用可能です。トレイメニューの「更新」から更新できます。"),
            NativeLocalization.KoreanLocale => new(
                "업데이트 확인",
                "업데이트 확인 중…",
                "{0}(으)로 업데이트",
                "다운로드 중 {0}%",
                "업데이트 설치 중…",
                "최신 버전입니다",
                "최신 버전({0})을 사용하고 있습니다.",
                "새 버전",
                "새 버전 {0}을(를) 사용할 수 있습니다(현재 {1}). 지금 업데이트하시겠습니까?",
                "지금은 업데이트를 확인할 수 없습니다",
                "최신 버전을 가져오지 못했습니다. 잠시 후 다시 시도하세요.\n공식 릴리스 페이지에서 직접 다운로드할 수도 있습니다.",
                "공식 릴리스 페이지를 여시겠습니까?",
                "GitHub API 재시도 가능 시간: {0}",
                "업데이트 파일 검증 실패",
                "다운로드한 설치 파일이 공식 체크섬과 일치하지 않아 삭제했으며 설치하지 않았습니다. 나중에 다시 시도하거나 GitHub에서 직접 다운로드하세요.",
                "새 버전 {0}을(를) 사용할 수 있습니다. 트레이 메뉴의 '업데이트'에서 업그레이드하세요."),
            _ => new(
                "Check for Updates",
                "Checking for updates…",
                "Update to {0}",
                "Downloading {0}%",
                "Installing update…",
                "You're up to date",
                "You're on the latest version ({0}).",
                "Update available",
                "Version {0} is available (current {1}). Update now?",
                "Couldn't check for updates right now",
                "Couldn't get the latest version. Please try again later.\nYou can also try downloading manually from the official release page.",
                "Open the official release page now?",
                "GitHub API can be retried after: {0}",
                "Update verification failed",
                "The downloaded installer didn't match the official checksum. It was deleted and nothing was installed. Try again later or download manually from GitHub.",
                "Version {0} is available — choose \"Update\" in the tray menu to upgrade."),
        };
    }
}
