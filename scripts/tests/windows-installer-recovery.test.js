import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildInstallerRecovery } from '../../packages/desktop/scripts/installer-recovery-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'packages/desktop/build/InstallerRecovery.cs');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

describe('installer recovery user contract', () => {
  it('shows Chinese explanations and the actual conflict', () => {
    const guard = read('packages/desktop/build/installer-safety.nsh');
    expect(guard).toContain('冲突位置：$OttoSafetyConflictPath');
    expect(guard).toContain('保留原文件');
    expect(guard).toContain('安全恢复');
    expect(guard).toContain('Call OttoSafetyStartRecovery');
    expect(guard).toContain('IfSilent');
    expect(guard).toContain('StrCpy $OttoSafetyConflictPath "$0\\$2"');
  });
  it('keeps the upstream installer, no silent bypass or deletion of originals', () => {
    const source = readFileSync(helper, 'utf8');
    expect(source).not.toMatch(/File\.Delete|Directory\.Delete|DeleteSubKey|ExecutionPolicy/u);
    expect(source).toContain('RegRenameKey');
    expect(source).toContain('Restore(');
    expect(source).toContain('FreshDestination(');
    expect(source).toContain('WaitForExit');
    expect(source).toContain('FileShare.Read');
    expect(source).toContain('RegistryHive.LocalMachine');
    expect(source).toContain('MessageBoxDefaultButton.Button2');
    expect(JSON.parse(read('packages/desktop/package.json')).build.nsis.script).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'win32')('Windows recovery native filesystem and isolated registry', () => {
  it.skipIf(!process.env.OTTO_NSIS_SAFETY_MAKENSIS)('extracts and launches the recovery entry with the same installer and parent PID (non-installing fixture)', async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'otto-recovery-entry-'));
    const argsFile = path.join(fixture, 'arguments.txt');
    const stub = path.join(fixture, 'stub.cs');
    const stubExe = path.join(fixture, 'stub.exe');
    writeFileSync(stub, `class Entry { static void Main(string[] args) { System.IO.File.WriteAllLines(${JSON.stringify(argsFile)}, args); } }`);
    const built = spawnSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/target:winexe', '/out:' + stubExe, stub], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    // Only the transport entry runs. A harmless argument-recording child takes
    // the helper's place; no product registration, installer or uninstaller runs.
    const include = path.join(fixture, 'safety.nsh');
    writeFileSync(include, read('packages/desktop/build/installer-safety.nsh').replace(/^\s*MessageBox[^\r\n]*$/gmu, '      SetErrorLevel 79'));
    const quote = (value) => '"' + value.replaceAll('$', '$$').replaceAll('"', '$\\"') + '"';
    const script = path.join(fixture, 'entry.nsi');
    const exe = path.join(fixture, 'entry.exe');
    writeFileSync(script, [
      'Unicode true', 'Name "Otto recovery NON-INSTALLING fixture"', 'RequestExecutionLevel user', 'SilentInstall silent',
      'OutFile ' + quote(exe),
      '!define APP_EXECUTABLE_FILENAME "Otto.exe"', '!define UNINSTALL_FILENAME "Uninstall Otto.exe"',
      '!define INSTALL_REGISTRY_KEY "Software\\bc38908e-1ce2-5555-aca4-b7da2295894c"',
      '!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\bc38908e-1ce2-5555-aca4-b7da2295894c"',
      '!define OTTO_RECOVERY_HELPER ' + quote(stubExe), '!include ' + quote(include), '!insertmacro customHeader',
      'Function .onInit', 'Call OttoSafetyStartRecovery', 'SetErrorLevel 0', 'Quit', 'FunctionEnd', 'Section "none"', 'SectionEnd',
    ].join('\n'));
    const compiled = spawnSync(process.env.OTTO_NSIS_SAFETY_MAKENSIS, ['/V2', '/INPUTCHARSET', 'UTF8', script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = spawnSync(exe, ['/S'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    await expect.poll(() => existsSync(argsFile), { timeout: 5000 }).toBe(true);
    const args = readFileSync(argsFile, 'utf8').trim().split(/\r?\n/u);
    expect(args).toHaveLength(3);
    expect(args[0]).toBe('--installer');
    expect(args[1].toLowerCase()).toBe(exe.toLowerCase());
    expect(args[2]).toMatch(/^\d+$/u);
  }, 45000);

  it('compiles the packaged helper and verifies its non-UI transaction primitives', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'otto-recovery-contract-'));
    expect(buildInstallerRecovery(path.join(fixture, 'InstallerRecovery.exe'))).toMatch(/InstallerRecovery\.exe$/u);
    const source = path.join(fixture, 'Check.cs');
    const exe = path.join(fixture, 'check.exe');
    writeFileSync(source, `
using System;
using System.IO;
using System.Reflection;
using Microsoft.Win32;
class Check {
  const string ProductKey="bc38908e-1ce2-5555-aca4-b7da2295894c";
  static void Need(bool value, string label) { if(!value) throw new Exception(label); }
  static void Reject(Action action, string label) { bool rejected=false; try { action(); } catch(InvalidOperationException) { rejected=true; } Need(rejected,label); }
  static object Call(string name, params object[] args) {
    try { return typeof(InstallerRecovery).GetMethod(name,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args); }
    catch(TargetInvocationException error) { throw error.InnerException; }
  }
  static void Settlement(RegistryKey registry, string root, string scenario) {
    using(var install=registry.CreateSubKey(scenario+"-install"))
    using(var uninstall=registry.CreateSubKey(scenario+"-uninstall")) {
      foreach(var parent in new[]{install,uninstall}) using(var key=parent.CreateSubKey(ProductKey)) key.SetValue("marker","original");
      var id=Guid.NewGuid().ToString("N");
      var journal=new InstallerRecovery.Journal{Id=id,Version="1.9.15",Stage="prepared",HadInstall=true,HadUninstall=true};
      var pending=Path.Combine(root,"pending-"+id+".json");
      Call("WriteJournal",pending,journal);
      var entries=(InstallerRecovery.Entry[])Call("Entries",install,uninstall,id);
      if(scenario=="interrupted") InstallerRecovery.Protect(new[]{entries[0]});
      else InstallerRecovery.Protect(entries);
      if(scenario=="partial" || scenario=="foreign") {
        var target=(string)Call("Destination",id);
        using(var key=install.CreateSubKey(ProductKey)) key.SetValue("InstallLocation",scenario=="partial"?target:"foreign-owner");
        using(var key=uninstall.CreateSubKey(ProductKey)) key.SetValue("UninstallString", ((char)34)+Path.Combine(target,"Uninstall Otto.exe")+((char)34)+" /currentuser");
      }
      if(scenario=="foreign") {
        Reject(()=>Call("Settle",journal,install,uninstall,pending),"foreign registration overwritten by settlement");
        Need(File.Exists(pending),"unresolved journal discarded");
        using(var key=install.OpenSubKey(ProductKey))Need((string)key.GetValue("InstallLocation")=="foreign-owner","foreign registration changed");
        Need(InstallerRecovery.Exists(install,entries[0].Backup),"original registration lost");
        return;
      }
      Call("Settle",journal,install,uninstall,pending);
      foreach(var parent in new[]{install,uninstall}) using(var key=parent.OpenSubKey(ProductKey))Need((string)key.GetValue("marker")=="original","settlement failed to restore original");
      using(var key=uninstall.OpenSubKey(ProductKey))Need(key.GetValue("SystemComponent")==null,"restored original still hidden");
      Need(!File.Exists(pending) && File.Exists(Path.Combine(root,"restored-"+id+".json")),"restoration receipt missing");
      if(scenario=="partial") using(var key=uninstall.OpenSubKey(ProductKey+".otto-incomplete-"+id))Need((int)key.GetValue("SystemComponent")==1,"incomplete new uninstaller remains visible");
    }
  }
  public static int Main(string[] args) {
    var root=args[0];
    var fresh=Path.Combine(root,"Otto 中文目录");
    InstallerRecovery.FreshDestination(fresh,new string[0]);
    Directory.CreateDirectory(fresh);File.WriteAllText(Path.Combine(fresh,"keep.txt"),"user-owned");
    Reject(()=>InstallerRecovery.FreshDestination(fresh,new string[0]),"existing target accepted");
    Reject(()=>InstallerRecovery.FreshDestination(Path.Combine(root,"new"),new[]{root}),"nested old directory accepted");
    Reject(()=>InstallerRecovery.FreshDestination(Path.GetPathRoot(root),new string[0]),"drive root accepted");
    var repo=Path.Combine(root,"repo");Directory.CreateDirectory(Path.Combine(repo,".git"));
    Reject(()=>InstallerRecovery.FreshDestination(Path.Combine(repo,"Otto"),new string[0]),"repository accepted");
    var keyName="Software\\\\OttoInstallerRecoveryTests\\\\"+Guid.NewGuid().ToString("N");
    using(var user=RegistryKey.OpenBaseKey(RegistryHive.CurrentUser,RegistryView.Registry64)) {
      try {
      using(var registry=user.CreateSubKey(keyName)) {
        foreach(var name in new[]{"install","uninstall"}) using(var key=registry.CreateSubKey(name)) { key.SetValue("marker","original-"+name);key.SetValue("binary",new byte[]{1,2,255},RegistryValueKind.Binary); }
        var entries=new[]{new InstallerRecovery.Entry{Parent=registry,Name="install",Backup="install-preserved"},new InstallerRecovery.Entry{Parent=registry,Name="uninstall",Backup="uninstall-preserved",HideInApps=true}};
        InstallerRecovery.Protect(entries);
        Need(!InstallerRecovery.Exists(registry,"install"),"old registration active");
        using(var key=registry.OpenSubKey("uninstall-preserved"))Need((int)key.GetValue("SystemComponent")==1,"old uninstall remains visible");
        InstallerRecovery.Restore(entries);
        using(var key=registry.OpenSubKey("uninstall"))Need(key.GetValue("SystemComponent")==null,"restored app remains hidden");
        using(var key=registry.OpenSubKey("install")){Need((string)key.GetValue("marker")=="original-install","restore failed");Need(((byte[])key.GetValue("binary"))[2]==255,"binary metadata lost");}
        // Failed second native rename must roll back the first without data loss.
        using(var nested=registry.CreateSubKey("readonly"))using(var key=nested.CreateSubKey("old"))key.SetValue("marker","keep");
        using(var denied=registry.OpenSubKey("readonly",false)) {
          var partial=new[]{entries[0],new InstallerRecovery.Entry{Parent=denied,Name="old",Backup=@"invalid\\nested"}};
          Reject(()=>InstallerRecovery.Protect(partial),"invalid native rename accepted");
          Need(InstallerRecovery.Exists(registry,"install"),"partial failure did not restore first entry");
        }
        using(var key=registry.CreateSubKey("uninstall-preserved"))key.SetValue("marker","untouched");
        Reject(()=>InstallerRecovery.Protect(entries),"backup collision accepted");
        Need(InstallerRecovery.Exists(registry,"install"),"first registration stranded");
        using(var key=registry.OpenSubKey("uninstall-preserved"))Need((string)key.GetValue("marker")=="untouched","foreign backup overwritten");
        Reject(()=>InstallerRecovery.Restore(entries),"conflicting canonical registration overwritten");
        Settlement(registry,root,"interrupted");
        Settlement(registry,root,"partial");
        Settlement(registry,root,"foreign");
        // A pre-existing marker must not be mistaken for our recovery metadata.
        using(var parent=registry.CreateSubKey("marker-conflict")) {
          using(var key=parent.CreateSubKey("original")){key.SetValue("SystemComponent",42);key.SetValue("OttoRecoveryOriginalSystemComponent","missing");}
          var conflict=new[]{new InstallerRecovery.Entry{Parent=parent,Name="original",Backup="preserved",HideInApps=true}};
          Reject(()=>InstallerRecovery.Protect(conflict),"foreign marker accepted");
          using(var key=parent.OpenSubKey("original"))Need(Object.Equals(key.GetValue("SystemComponent"),42),"foreign visibility metadata modified");
        }
        Need(File.ReadAllText(Path.Combine(fresh,"keep.txt"))=="user-owned","original file changed");
      }
      } finally {
        // Only our unique test-created namespace is removed, never product keys.
        Need(keyName.StartsWith("Software\\\\OttoInstallerRecoveryTests\\\\"),"invalid test cleanup");
        user.DeleteSubKeyTree(keyName);
      }
    }
    Console.WriteLine("RECOVERY_CONTRACT_PASS");return 0;
  }
}`, 'utf8');
    const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/main:Check', '/warnaserror+', '/utf8output', '/reference:System.Windows.Forms.dll', '/reference:System.Runtime.Serialization.dll', '/out:' + exe, helper, source], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = spawnSync(exe, [fixture], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('RECOVERY_CONTRACT_PASS');
  }, 45000);
});
