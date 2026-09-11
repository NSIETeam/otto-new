// Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
// Built with the Windows .NET Framework compiler. No scripts, policy changes,
// downloads, elevation, original-directory writes or old uninstaller execution.
using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

public static class InstallerRecovery {
    const string GuidKey = "bc38908e-1ce2-5555-aca4-b7da2295894c";
    const string UninstallParent = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern int RegRenameKey(IntPtr parent, string oldName, string newName);

    public sealed class Entry {
        public RegistryKey Parent;
        public string Name, Backup;
        public bool Renamed;
        public bool HideInApps;
    }
    [DataContract] public sealed class Journal {
        [DataMember] public string Id;
        [DataMember] public string Version;
        [DataMember] public string Stage;
        [DataMember] public string InstallerSha256;
        [DataMember] public bool HadInstall;
        [DataMember] public bool HadUninstall;
    }
    static void Need(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    public static bool Exists(RegistryKey parent, string name) {
        using (var key = parent.OpenSubKey(name)) return key != null;
    }
    static void Rename(Entry entry, bool restore) {
        var from = restore ? entry.Backup : entry.Name;
        var to = restore ? entry.Name : entry.Backup;
        Need(!Exists(entry.Parent, to), "安装登记发生变化，已保留两份记录，未覆盖任何记录。");
        int result = RegRenameKey(entry.Parent.Handle.DangerousGetHandle(), from, to);
        Need(result == 0, "无法保存或恢复安装登记（" + result + "）。原文件未删除。");
    }
    public static void HideBackup(Entry entry) {
        if (!entry.HideInApps || !Exists(entry.Parent, entry.Backup)) return;
        using (var key = entry.Parent.OpenSubKey(entry.Backup, true)) {
            var original = key.GetValue("SystemComponent");
            Need(original == null || original is int, "旧版程序可见性登记无法安全保存。");
            Need(key.GetValue("OttoRecoveryOriginalSystemComponent") == null, "恢复标记冲突，未覆盖记录。");
            key.SetValue("OttoRecoveryOriginalSystemComponent", original == null ? "missing" : ((int)original).ToString(), RegistryValueKind.String);
            key.SetValue("SystemComponent", 1, RegistryValueKind.DWord);
        }
    }
    static void UnhideBackup(Entry entry) {
        if (!entry.HideInApps) return;
        using (var key = entry.Parent.OpenSubKey(entry.Backup, true)) {
            var original = key.GetValue("OttoRecoveryOriginalSystemComponent") as string;
            if (original == null) return;
            int value;
            if (original == "missing") key.DeleteValue("SystemComponent", false);
            else { Need(Int32.TryParse(original, out value), "原登记恢复标记异常。"); key.SetValue("SystemComponent", value, RegistryValueKind.DWord); }
            key.DeleteValue("OttoRecoveryOriginalSystemComponent", false);
        }
    }
    public static void Restore(Entry[] entries) {
        // Preflight the entire restoration, not only the first key.
        foreach (var e in entries.Where(e => Exists(e.Parent, e.Backup)))
            Need(!Exists(e.Parent, e.Name), "发现新的安装登记，不能自动覆盖。恢复记录已保留。");
        foreach (var e in entries.Reverse()) {
            if (!Exists(e.Parent, e.Backup)) continue;
            UnhideBackup(e);
            Rename(e, true); e.Renamed = false;
        }
    }
    public static void Protect(Entry[] entries) {
        foreach (var e in entries) {
            Need(!Exists(e.Parent, e.Backup), "恢复记录已存在，不能覆盖。");
            if (e.HideInApps) using (var key = e.Parent.OpenSubKey(e.Name)) {
                if (key == null) continue;
                var original = key.GetValue("SystemComponent");
                Need(original == null || original is int, "旧版程序可见性登记无法安全保存。");
                Need(key.GetValue("OttoRecoveryOriginalSystemComponent") == null, "恢复标记冲突，原安装登记未修改。");
            }
        }
        try {
            foreach (var e in entries) {
                if (!Exists(e.Parent, e.Name)) continue;
                Rename(e, false); e.Renamed = true;
                HideBackup(e);
            }
        } catch {
            // Restore only this transaction's successful renames.
            Restore(entries.Where(e => e.Renamed).ToArray());
            throw;
        }
    }
    public static void OrdinaryAncestors(string path) {
        Need(Regex.IsMatch(path, @"^[A-Za-z]:\\") &&
            path.IndexOfAny(new [] { '"', '\r', '\n', '~', '/' }) < 0 &&
            path.Substring(3).IndexOf(':') < 0 &&
            String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase),
            "请选择普通的本机目录，不能使用网络路径或重定向路径。");
        foreach (var part in path.Substring(3).Split('\\'))
            Need(part.Length > 0 && !part.EndsWith(".") && !part.EndsWith(" "), "目录名称不规范。");
        for (var current = path; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
            FileAttributes attr;
            try { attr = File.GetAttributes(current); }
            catch (FileNotFoundException) { continue; }
            catch (DirectoryNotFoundException) { continue; }
            Need((attr & FileAttributes.ReparsePoint) == 0 && (attr & FileAttributes.Directory) != 0,
                "目录中存在链接或非文件夹，已停止恢复：" + current);
            foreach (var marker in new [] { ".git", ".hg", ".svn" })
                Need(!File.Exists(Path.Combine(current, marker)) && !Directory.Exists(Path.Combine(current, marker)),
                    "恢复位置不能位于源码仓库内：" + current);
        }
    }
    public static void FreshDestination(string path, string[] originals) {
        OrdinaryAncestors(path);
        Need(path.Length > 3 && !File.Exists(path) && !Directory.Exists(path), "恢复位置已存在；不会覆盖原文件：" + path);
        foreach (var original in originals.Where(v => !String.IsNullOrWhiteSpace(v))) {
            string old;
            try { old = Path.GetFullPath(original).TrimEnd('\\'); }
            catch { throw new InvalidOperationException("旧安装路径无法确认，已保留原记录，请联系支持。"); }
            Need(!path.Equals(old, StringComparison.OrdinalIgnoreCase) && !path.StartsWith(old + "\\", StringComparison.OrdinalIgnoreCase),
                "新位置不能位于旧安装目录内。原目录及文件将保留。");
        }
    }
    static string TextValue(RegistryKey parent, string name, string value) {
        using (var key = parent.OpenSubKey(name)) return key == null ? "" : Convert.ToString(key.GetValue(value, ""));
    }
    static string Version(string file) {
        var value = FileVersionInfo.GetVersionInfo(file).ProductVersion;
        Need(value != null && Regex.IsMatch(value, @"^\d+\.\d+\.\d+(\.\d+)?$"), "安装包版本无法确认，请重新下载正式安装包。");
        return String.Join(".", value.Split('.').Take(3));
    }
    static string Destination(string id) {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Otto-Recovered-" + id);
    }
    static bool Installed(Journal journal, RegistryKey install) {
        var target = Destination(journal.Id);
        if (!String.Equals(TextValue(install, GuidKey, "InstallLocation"), target, StringComparison.OrdinalIgnoreCase)) return false;
        if (!File.Exists(Path.Combine(target, "Otto.exe")) || !File.Exists(Path.Combine(target, "resources", "app.asar")) || !File.Exists(Path.Combine(target, "Uninstall Otto.exe"))) return false;
        try { return Version(Path.Combine(target, "Otto.exe")) == journal.Version; }
        catch (IOException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
    static void WriteJournal(string file, Journal value) {
        // Immutable intent: create before either registry rename; never overwrite.
        using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
            new DataContractJsonSerializer(typeof(Journal)).WriteObject(stream, value);
            stream.Flush(true);
        }
    }
    static Journal ReadJournal(string file) {
        Need((File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0 && new FileInfo(file).Length <= 4096, "恢复记录无法安全读取。");
        using (var stream = File.OpenRead(file)) {
            var value = (Journal)new DataContractJsonSerializer(typeof(Journal)).ReadObject(stream);
            Need(Regex.IsMatch(value.Id ?? "", "^[a-f0-9]{32}$") && Regex.IsMatch(value.Version ?? "", @"^\d+\.\d+\.\d+$") && value.Stage == "prepared", "恢复记录格式不正确，已停止操作。");
            return value;
        }
    }
    static Entry[] Entries(RegistryKey install, RegistryKey uninstall, string id) {
        return new [] {
            new Entry { Parent = install, Name = GuidKey, Backup = GuidKey + ".otto-preserved-" + id },
            new Entry { Parent = uninstall, Name = GuidKey, Backup = GuidKey + ".otto-preserved-" + id, HideInApps = true }
        };
    }
    static void FinishJournal(string pending, Journal journal, string outcome) {
        File.Move(pending, Path.Combine(Path.GetDirectoryName(pending), outcome + "-" + journal.Id + ".json"));
    }
    static void Settle(Journal journal, RegistryKey install, RegistryKey uninstall, string pending) {
        var entries = Entries(install, uninstall, journal.Id);
        if (Installed(journal, install)) {
            Need(String.Equals(TextValue(uninstall, GuidKey, "UninstallString"), "\"" + Path.Combine(Destination(journal.Id), "Uninstall Otto.exe") + "\" /currentuser", StringComparison.OrdinalIgnoreCase), "新安装的卸载登记尚未确认，恢复记录已保留。");
            FinishJournal(pending, journal, "installed"); return;
        }
        // If the child produced new registration, retain it under a separate name
        // before restoring the original. Never remove data or unknown registrations.
        bool ownsNew = String.Equals(TextValue(install, GuidKey, "InstallLocation"), Destination(journal.Id), StringComparison.OrdinalIgnoreCase);
        if (ownsNew) {
            var command = TextValue(uninstall, GuidKey, "UninstallString");
            Need(command == "" || String.Equals(command, "\"" + Path.Combine(Destination(journal.Id), "Uninstall Otto.exe") + "\" /currentuser", StringComparison.OrdinalIgnoreCase), "卸载登记由其他操作改变，未覆盖。");
            Protect(new [] {
                new Entry { Parent = install, Name = GuidKey, Backup = GuidKey + ".otto-incomplete-" + journal.Id },
                new Entry { Parent = uninstall, Name = GuidKey, Backup = GuidKey + ".otto-incomplete-" + journal.Id, HideInApps = true }
            });
        }
        Restore(entries);
        Need(!journal.HadInstall || Exists(install, GuidKey), "原安装登记恢复未完成，请保留恢复记录。");
        Need(!journal.HadUninstall || Exists(uninstall, GuidKey), "原卸载登记恢复未完成，请保留恢复记录。");
        FinishJournal(pending, journal, "restored");
    }
    static bool Confirm(string message) {
        return MessageBox.Show(message, "Otto 安全恢复", MessageBoxButtons.YesNo,
            MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
    }
    static Mutex InstallerGate() {
        bool created;
        var gate = new Mutex(true, GuidKey, out created);
        if (!created) { gate.Dispose(); throw new InvalidOperationException("另一个 Otto 安装进程仍在运行，请等待结束后重新打开恢复向导。"); }
        return gate;
    }
    static void RequireOttoClosed() {
        foreach (var process in Process.GetProcessesByName("Otto"))
            using (process) Need(process.SessionId != Process.GetCurrentProcess().SessionId, "请先退出正在运行的 Otto（包括托盘中的 Otto），再重试安全恢复。无需卸载。");
    }
    static int WaitForInstaller(Process child) {
        using (var progress = new Form { Text = "Otto 安全恢复", Width = 520, Height = 160, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = true, ControlBox = false }) {
            progress.Controls.Add(new Label { Text = "正在安装到新的独立目录，请稍候。\n旧目录和文件不会删除；请不要同时运行其他安装包。", AutoSize = false, Dock = DockStyle.Top, Height = 70, Padding = new Padding(16) });
            progress.Controls.Add(new ProgressBar { Style = ProgressBarStyle.Marquee, Dock = DockStyle.Bottom, Height = 20 });
            progress.Show();
            var elapsed = Stopwatch.StartNew();
            while (!child.WaitForExit(100)) {
                Application.DoEvents();
                // An unknown outcome is not a reason to kill the installer or
                // restore registration while it is still running. InstallerGate
                // prevents settlement and pending.json remains for a later check.
                Need(elapsed.Elapsed < TimeSpan.FromMinutes(15), "安装等待时间较长，暂时无法确认结果。未强制结束安装，请等待安装进程退出后重新打开恢复向导核对。");
            }
            return child.ExitCode;
        }
    }
    [STAThread] public static int Main(string[] args) {
        Application.EnableVisualStyles();
        string recoveryRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OttoInstallRecovery");
        try {
            Need(args.Length == 3 && args[0] == "--installer", "请从 Otto 安装器的“安全恢复”入口打开。");
            int parentId; Need(Int32.TryParse(args[2], out parentId) && parentId > 0, "安装进程信息不完整。");
            // The parent must release electron-builder's installer mutex first.
            try { using (var parent = Process.GetProcessById(parentId)) Need(parent.WaitForExit(30000), "原安装器尚未退出，请关闭后重试。"); }
            catch (ArgumentException) { }
            var installer = Path.GetFullPath(args[1]);
            Need(File.Exists(installer) && (File.GetAttributes(installer) & FileAttributes.ReparsePoint) == 0, "原安装包不存在或已被替换，请重新下载。");
            bool created;
            using (var mutex = new Mutex(true, @"Local\OttoInstallRecovery-" + Environment.UserName, out created)) {
                Need(created, "安全恢复已在运行，请返回已有窗口。");
                // Holding a read-only handle denies replacement/modification while
                // hashing, reviewing and executing the exact same installer file.
                using (var lockedInstaller = new FileStream(installer, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var current = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64))
                using (var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (var machine32 = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32))
                using (var install = current.CreateSubKey("Software"))
                using (var uninstall = current.CreateSubKey(UninstallParent)) {
                    Need(!Exists(machine, "Software\\" + GuidKey) && !Exists(machine, UninstallParent + "\\" + GuidKey), "检测到全用户安装。此恢复入口仅处理当前用户安装，不会修改管理员的安装登记。请联系管理员处理；不要手动卸载或删除原目录。");
                    Need(!Exists(machine32, "Software\\" + GuidKey) && !Exists(machine32, UninstallParent + "\\" + GuidKey), "检测到另一架构的全用户安装，已保留原登记，请联系管理员处理。");
                    OrdinaryAncestors(recoveryRoot);
                    Directory.CreateDirectory(recoveryRoot);
                    var pending = Path.Combine(recoveryRoot, "pending.json");
                    if (File.Exists(pending)) {
                        var previous = ReadJournal(pending);
                        if (!Confirm("检测到上次恢复未完成。是否先核对结果并恢复原安装登记？\n\n原目录和文件不会删除；已成功安装的新版也不会被覆盖。")) return 1;
                        using (var gate = InstallerGate()) Settle(previous, install, uninstall, pending);
                        MessageBox.Show("上次恢复结果已核对。原文件保留；可以重新打开安装包继续。", "Otto 安全恢复");
                        return 0;
                    }
                    var id = System.Guid.NewGuid().ToString("N");
                    var target = Destination(id);
                    var old = TextValue(install, GuidKey, "InstallLocation");
                    FreshDestination(target, new [] { old });
                    var version = Version(installer);
                    string hash;
                    using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(lockedInstaller)).Replace("-", "").ToLowerInvariant();
                    if (!Confirm("将保留原文件，在新的独立目录安装 Otto " + version + "。\n\n原目录：" + (old == "" ? "未登记" : old) + "\n新目录：" + target + "\n\n不会运行旧卸载器，不删除聊天资料、源码或其他文件。原安装登记会先保存；成功后快捷方式指向新版。失败可恢复原登记。\n\n是否开始安全恢复？")) return 1;
                    FreshDestination(target, new [] { TextValue(install, GuidKey, "InstallLocation") });
                    var journal = new Journal { Id = id, Version = version, Stage = "prepared", InstallerSha256 = hash, HadInstall = Exists(install, GuidKey), HadUninstall = Exists(uninstall, GuidKey) };
                    try {
                        // Preserve a verified copy so installer cache updates cannot
                        // overwrite the file currently being executed/held open.
                        var copy = Path.Combine(recoveryRoot, "setup-" + id + ".exe");
                        using (var output = new FileStream(copy, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { lockedInstaller.Position = 0; lockedInstaller.CopyTo(output); output.Flush(true); }
                        using (var gate = InstallerGate()) {
                            RequireOttoClosed();
                            FreshDestination(target, new [] { TextValue(install, GuidKey, "InstallLocation") });
                            WriteJournal(pending, journal);
                            Protect(Entries(install, uninstall, id));
                        }
                        var start = new ProcessStartInfo(copy, "/S /currentuser /D=" + target) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = recoveryRoot };
                        int code;
                        using (var heldCopy = new FileStream(copy, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                            string copiedHash;
                            using (var sha = SHA256.Create()) copiedHash = BitConverter.ToString(sha.ComputeHash(heldCopy)).Replace("-", "").ToLowerInvariant();
                            Need(copiedHash == hash, "恢复安装包校验失败，未执行。");
                            using (var child = Process.Start(start)) code = WaitForInstaller(child);
                        }
                        Need(code == 0 && Installed(journal, install), "安装未完成（退出码 " + code + "）。正在核对并恢复原安装登记。");
                        using (var gate = InstallerGate()) Settle(journal, install, uninstall, pending);
                        MessageBox.Show("恢复安装完成。请从桌面 Otto 快捷方式打开新版。\n\n新位置：" + target + "\n原位置：" + (old == "" ? "未登记" : old) + "\n\n原目录和文件完整保留，请不要再运行旧目录里的卸载程序。\n恢复记录：" + recoveryRoot, "Otto 安全恢复", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        return 0;
                    } catch {
                        if (File.Exists(pending)) using (var gate = InstallerGate()) Settle(journal, install, uninstall, pending);
                        throw;
                    }
                }
            }
        } catch (Exception error) {
            MessageBox.Show(error.Message + "\n\n原目录和文件未删除。恢复记录：" + recoveryRoot + "\n请保留此信息并联系 Otto 支持，无需手动修改注册表。", "Otto 安全恢复未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }
    }
}
