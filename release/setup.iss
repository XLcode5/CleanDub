; CleanDub 安装程序脚本（Inno Setup）
; 下载 Inno Setup: https://jrsoftware.org/isdl.php

#define MyAppName "CleanDub"
#define MyAppVersion "0.3.0"
#define MyAppPublisher "XLcode5"
#define MyAppURL "https://github.com/XLcode5/CleanDub"
#define MyAppExeName "CleanDub.exe"

[Setup]
; 基础信息
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
LicenseFile=LICENSE.txt
OutputDir=..\installer
OutputBaseFilename=CleanDub-Setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; 界面语言
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; 安装类型
[Types]
Name: "full"; Description: "完整安装"
Name: "custom"; Description: "自定义安装"; Flags: iscustom

; 组件
[Components]
Name: "main"; Description: "主程序"; Types: full custom; Flags: fixed
Name: "desktopicon"; Description: "创建桌面快捷方式"; Types: full

; 文件
[Files]
Source: "CleanDub\CleanDub.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "CleanDub\dedup_core.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "CleanDub\dedup_server.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "CleanDub\dedup_ui.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "CleanDub\version.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "CleanDub\config.json"; DestDir: "{app}"; Flags: ignoreversion

; 快捷方式
[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Components: desktopicon

; 注册表（可选：开机启动）
[Registry]
; 取消注释以启用开机启动
; Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "CleanDub"; ValueData: "{app}\{#MyAppExeName}"; Flags: uninsdeletevalue

; 卸载清理
[UninstallDelete]
Type: filesandordirs; Name: "{app}"
