using System.IO;
using System.Text.Json;
using System.Windows.Forms;

namespace TokenTrackerWin.TrccFork.MetricsBar;

/// <summary>Single entry point for the taskbar metrics bar (TRCC fork).</summary>
internal sealed class MetricsBarHost : IDisposable
{
    private readonly Action<Action> _postToUi;
    private readonly ToolStripMenuItem _menuItem;
    private readonly MetricsBarPoller _poller = new();
    private readonly TaskbarEmbedder _embedder = new();
    private readonly System.Windows.Forms.Timer _taskbarTimer;
    private readonly FileSystemWatcher? _watcher;
    private MetricsBarForm? _form;
    private MetricsBarSettings _settings = MetricsBarSettings.Load();
    private bool _english;

    public static MetricsBarHost? Instance { get; private set; }

    private MetricsBarHost(ContextMenuStrip menu, Action<Action> postToUi, bool english)
    {
        _postToUi = postToUi;
        _english = english;
        _menuItem = new ToolStripMenuItem(MetricsBarStrings.MenuTitle(english))
        {
            CheckOnClick = true,
            Checked = _settings.Enabled,
        };
        _menuItem.Click += (_, _) => ToggleEnabled(_menuItem.Checked);

        var insert = Math.Min(4, menu.Items.Count);
        menu.Items.Insert(insert, _menuItem);

        _poller.Updated += OnPollerUpdated;
        _poller.ApplySettings(_settings);

        _taskbarTimer = new System.Windows.Forms.Timer { Interval = 1500 };
        _taskbarTimer.Tick += (_, _) => _postToUi(MaintainTaskbarEmbed);

        try
        {
            var dir = Path.GetDirectoryName(MetricsBarSettings.SettingsPath)!;
            var file = Path.GetFileName(MetricsBarSettings.SettingsPath);
            _watcher = new FileSystemWatcher(dir, file)
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName,
            };
            _watcher.Changed += (_, _) => _postToUi(ReloadFromDisk);
            _watcher.EnableRaisingEvents = true;
        }
        catch { /* optional */ }

        if (_settings.Enabled) _postToUi(() => EnsureFormVisible());
    }

    public static MetricsBarHost Attach(ContextMenuStrip menu, Action<Action> postToUi, bool english)
    {
        Instance?.Dispose();
        Instance = new MetricsBarHost(menu, postToUi, english);
        return Instance;
    }

    public void SetEnglish(bool english)
    {
        _english = english;
        _menuItem.Text = MetricsBarStrings.MenuTitle(english);
        RefreshForm();
    }

    public void ApplySettingsJson(string json)
    {
        try
        {
            var next = JsonSerializer.Deserialize<MetricsBarSettings>(json, MetricsBarSettings.JsonOptions) ?? new();
            next.Normalize();
            _settings = next;
            _settings.Save();
            _menuItem.Checked = _settings.Enabled;
            _poller.ApplySettings(_settings);
            _postToUi(() =>
            {
                if (_settings.Enabled) EnsureFormVisible();
                else HideForm();
            });
        }
        catch (Exception ex)
        {
            Diag.Log("metrics-bar", $"apply settings failed: {ex.Message}");
        }
    }

    public string ReadSettingsJson()
    {
        _settings.Normalize();
        return JsonSerializer.Serialize(_settings, MetricsBarSettings.JsonOptions);
    }

    private void ToggleEnabled(bool on)
    {
        _settings.Enabled = on;
        _settings.Save();
        _poller.ApplySettings(_settings);
        if (on) EnsureFormVisible();
        else HideForm();
    }

    private void ReloadFromDisk()
    {
        _settings = MetricsBarSettings.Load();
        _menuItem.Checked = _settings.Enabled;
        _poller.ApplySettings(_settings);
        if (_settings.Enabled) EnsureFormVisible();
        else HideForm();
        RefreshForm();
    }

    private void OnPollerUpdated() => _postToUi(RefreshForm);

    private void EnsureFormVisible()
    {
        _form ??= new MetricsBarForm(_embedder);
        if (!_form.IsHandleCreated)
            _ = _form.Handle;
        var showing = !_form.Visible;
        _form.UpdateView(_settings, _poller.Current, _english);
        if (showing)
        {
            _form.Show();
            _taskbarTimer.Start();
            _form.UpdateView(_settings, _poller.Current, _english);
            var parent = _form.IsHandleCreated ? TaskbarNative.GetParent(_form.Handle) : 0;
            Diag.Log("metrics-bar", parent != 0 ? $"embedded parent={parent}" : "embed pending (parent=0)");
        }
    }

    private void HideForm()
    {
        if (_form is null) return;
        _taskbarTimer.Stop();
        _form.Hide();
    }

    private void MaintainTaskbarEmbed()
    {
        if (_form is null || !_form.Visible || !_settings.Enabled) return;
        if (_form.MaintainEmbed())
            RefreshForm();
    }

    private void RefreshForm()
    {
        if (_form is null || !_settings.Enabled) return;
        _form.UpdateView(_settings, _poller.Current, _english);
    }

    public void Shutdown()
    {
        _form?.Close();
        _form?.Dispose();
        _form = null;
    }

    public void Dispose()
    {
        Shutdown();
        _taskbarTimer.Dispose();
        _poller.Dispose();
        _watcher?.Dispose();
        if (ReferenceEquals(Instance, this)) Instance = null;
    }
}