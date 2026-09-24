const path = require('path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// 开发者/发布者信息（证书主体、文件属性、卸载入口应保持一致）
const DEVELOPER_NAME = 'pashpon';
const DEVELOPER_CONTACT = 'pashpon@qq.com';

// 将字符串中的 XML 保留字符转义为实体（用于动态文本，避免破坏 WXS）
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 生成注入到 WXS 中的正式安装向导 UI。
 * 结构已在 _wixprobe/probe2.wxs 中用 WiX 3.14 验证可编译：
 *  - 自定义欢迎页（展示产品描述、版本、开发者、联系邮箱）
 *  - 自定义完成页
 *  - 复用 WixUIExtension 的标准维护/确认/进度对话框
 *  - 通过 InstallUISequence/AdminUISequence 编排展示时机
 * 文案按中文硬编码于 WXS，配合 Product Codepage="936" 避免 LGHT0311。
 */
function buildWixUI(creator) {
  const appName = creator.name || 'maxbox';
  const description = creator.description || 'maxbox 装箱容量计算与三维摆放方案工具';
  const version = creator.semanticVersion || creator.windowsCompliantVersion || '1.0.0';
  const developer = creator.manufacturer || DEVELOPER_NAME;
  const contact = DEVELOPER_CONTACT;

  return `
    <UI Id="MaxboxUI">
      <TextStyle Id="WixUI_Font_Normal" FaceName="Tahoma" Size="8" />
      <TextStyle Id="WixUI_Font_Bigger" FaceName="Tahoma" Size="12" />
      <TextStyle Id="WixUI_Font_Title" FaceName="Tahoma" Size="9" Bold="yes" />
      <Property Id="DefaultUIFont" Value="WixUI_Font_Normal" />
      <Property Id="ARPNOMODIFY" Value="1" />
      <DialogRef Id="ErrorDlg" />
      <DialogRef Id="FatalError" />
      <DialogRef Id="FilesInUse" />
      <DialogRef Id="MsiRMFilesInUse" />
      <DialogRef Id="CancelDlg" />
      <DialogRef Id="WaitForCostingDlg" />
      <DialogRef Id="ProgressDlg" />
      <DialogRef Id="ResumeDlg" />
      <DialogRef Id="UserExit" />
      <DialogRef Id="VerifyReadyDlg" />
      <DialogRef Id="MaintenanceWelcomeDlg" />
      <DialogRef Id="MaintenanceTypeDlg" />
      <Dialog Id="MaxboxWelcomeDlg" Width="370" Height="270" Title="${xmlEscape(appName)} 安装向导" NoMinimize="yes" TrackDiskSpace="yes">
        <Control Id="Bitmap" Type="Bitmap" X="0" Y="0" Width="370" Height="234" TabSkip="no" Text="WixUI_Bmp_Dialog" />
        <Control Id="Title" Type="Text" X="135" Y="18" Width="220" Height="34" Transparent="yes" NoPrefix="yes" Text="{\\WixUI_Font_Title}欢迎使用 ${xmlEscape(appName)} 安装向导" />
        <Control Id="Desc" Type="Text" X="135" Y="60" Width="220" Height="40" NoPrefix="yes" Text="${xmlEscape(description)}" />
        <Control Id="VersionLabel" Type="Text" X="135" Y="115" Width="220" Height="14" NoPrefix="yes" Text="产品版本：${xmlEscape(version)}" />
        <Control Id="DevLabel" Type="Text" X="135" Y="134" Width="220" Height="14" NoPrefix="yes" Text="开发者：${xmlEscape(developer)}" />
        <Control Id="MailLabel" Type="Text" X="135" Y="153" Width="220" Height="14" NoPrefix="yes" Text="联系邮箱：${xmlEscape(contact)}" />
        <Control Id="Notice" Type="Text" X="135" Y="180" Width="220" Height="40" NoPrefix="yes" Text="安装前请先关闭正在运行的 ${xmlEscape(appName)}。如有任何问题，欢迎联系开发者。Copyright (c) 2026 ${xmlEscape(developer)}。" />
        <Control Id="BottomLine" Type="Line" X="0" Y="234" Width="370" Height="0" />
        <Control Id="Back" Type="PushButton" X="180" Y="243" Width="56" Height="17" Disabled="yes" Text="上一步(&amp;B)" />
        <Control Id="Next" Type="PushButton" X="236" Y="243" Width="56" Height="17" Default="yes" Text="下一步(&amp;N)">
          <Publish Event="NewDialog" Value="VerifyReadyDlg">NOT Installed</Publish>
          <Publish Event="NewDialog" Value="MaintenanceTypeDlg">Installed AND NOT PATCH</Publish>
        </Control>
        <Control Id="Cancel" Type="PushButton" X="304" Y="243" Width="56" Height="17" Cancel="yes" Text="取消(&amp;C)">
          <Publish Event="EndDialog" Value="Return">1</Publish>
        </Control>
      </Dialog>
      <Dialog Id="MaxboxExitDlg" Width="370" Height="270" Title="${xmlEscape(appName)} 安装向导" NoMinimize="yes" TrackDiskSpace="yes">
        <Control Id="Bitmap" Type="Bitmap" X="0" Y="0" Width="370" Height="234" TabSkip="no" Text="WixUI_Bmp_Dialog" />
        <Control Id="Title" Type="Text" X="135" Y="22" Width="220" Height="30" Transparent="yes" NoPrefix="yes" Text="{\\WixUI_Font_Bigger}安装向导已完成" />
        <Control Id="Desc" Type="Text" X="135" Y="66" Width="220" Height="34" NoPrefix="yes" Text="请求的操作已成功完成，感谢您使用 ${xmlEscape(appName)}！" />
        <Control Id="DevLabel" Type="Text" X="135" Y="120" Width="220" Height="14" NoPrefix="yes" Text="开发者：${xmlEscape(developer)}" />
        <Control Id="MailLabel" Type="Text" X="135" Y="139" Width="220" Height="14" NoPrefix="yes" Text="联系邮箱：${xmlEscape(contact)}" />
        <Control Id="Notice" Type="Text" X="135" Y="170" Width="220" Height="34" NoPrefix="yes" Text="如您在安装或使用中遇到任何问题，欢迎通过以上邮箱联系开发者获得帮助。" />
        <Control Id="BottomLine" Type="Line" X="0" Y="234" Width="370" Height="0" />
        <Control Id="Back" Type="PushButton" X="180" Y="243" Width="56" Height="17" Disabled="yes" Text="上一步(&amp;B)" />
        <Control Id="Finish" Type="PushButton" X="236" Y="243" Width="56" Height="17" Default="yes" Text="完成(&amp;F)">
          <Publish Event="EndDialog" Value="Return" Order="999">1</Publish>
        </Control>
        <Control Id="Cancel" Type="PushButton" X="304" Y="243" Width="56" Height="17" Disabled="yes" Text="取消(&amp;C)" />
      </Dialog>
      <Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="MaxboxWelcomeDlg" Order="1">NOT Installed</Publish>
      <Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="MaintenanceTypeDlg" Order="2">Installed AND NOT PATCH</Publish>
      <Publish Dialog="MaintenanceWelcomeDlg" Control="Next" Event="NewDialog" Value="MaintenanceTypeDlg">1</Publish>
      <Publish Dialog="MaintenanceTypeDlg" Control="RepairButton" Event="NewDialog" Value="VerifyReadyDlg">1</Publish>
      <Publish Dialog="MaintenanceTypeDlg" Control="RemoveButton" Event="NewDialog" Value="VerifyReadyDlg">1</Publish>
      <Publish Dialog="MaintenanceTypeDlg" Control="Back" Event="NewDialog" Value="MaintenanceWelcomeDlg">1</Publish>
    </UI>
    <InstallUISequence>
      <Show Dialog="MaxboxWelcomeDlg" Sequence="1290">NOT Installed AND NOT RESUME</Show>
      <Show Dialog="MaintenanceWelcomeDlg" Sequence="1292">Installed AND NOT RESUME</Show>
      <Show Dialog="ResumeDlg" Sequence="1293">Installed AND RESUME</Show>
      <Show Dialog="ProgressDlg" Sequence="1299">1</Show>
      <Show Dialog="MaxboxExitDlg" OnExit="success">1</Show>
      <Show Dialog="UserExit" OnExit="cancel">1</Show>
      <Show Dialog="FatalError" OnExit="error">1</Show>
    </InstallUISequence>
    <AdminUISequence>
      <Show Dialog="MaxboxExitDlg" OnExit="success">1</Show>
      <Show Dialog="UserExit" OnExit="cancel">1</Show>
      <Show Dialog="FatalError" OnExit="error">1</Show>
    </AdminUISequence>`;
}

module.exports = {
  packagerConfig: {
    asar: true,
    // Windows 应用 / 快捷方式图标（多尺寸 .ico）
    icon: path.resolve(__dirname, 'build', 'icon.ico'),
    // 可执行文件「详细信息」页的版权声明（LegalCopyright）
    appCopyright: 'Copyright © 2026 pashpon',
    // 可执行文件「详细信息」页版本信息：公司/开发者名称、文件说明等
    win32metadata: {
      CompanyName: 'pashpon',
      FileDescription: 'maxbox 装箱容量计算与三维摆放方案工具',
      InternalName: 'maxbox',
      OriginalFilename: 'maxbox.exe',
      ProductName: 'maxbox',
    },
  },
  rebuildConfig: {},
  makers: [
    {
      // Windows MSI 安装包：一键安装，安装后自动创建
      // 「桌面快捷方式」和「开始菜单」快捷方式，并带标准卸载入口。
      name: '@electron-forge/maker-wix',
      config: {
        arch: 'x64', // MSI 声明 64 位平台
        language: 2052, // 中文（zh-CN）
        // 开发者/发布者名称：用于「应用与功能」中的发布者、
        // 开始菜单文件夹名与版权信息
        manufacturer: DEVELOPER_NAME,
        description: 'maxbox 装箱容量计算与三维摆放方案工具',
        // MSI 与快捷方式使用应用自身图标，避免从 exe 提取图标
        icon: path.resolve(__dirname, 'build', 'icon.ico'),
        // 升级标识（固定 GUID，保证后续版本可覆盖升级旧版）
        upgradeCode: '{F9111EC5-8C9F-4EE6-9032-06E48971CC7C}',
        // 让 WixUI 标准对话框与界面文本按中文(zh-CN)文化编译。
        // ui.template 留空 = 不使用 electron-wix-msi 自带 UI，仅借用
        // WixUIExtension（本文件 beforeCreate 会注入正式的自定义向导）。
        cultures: 'zh-CN',
        ui: { template: '' },
        beforeCreate(creator) {
          // electron-wix-msi 生成的 WXS 需要几处微调：
          //  1) 显式声明数据库代码页 936(GBK)，否则中文描述会触发
          //     light LGHT0311 报错（默认按 1252 建库）；
          //  2) 在「应用与功能」自定义卸载项中补充开发者联系邮箱 Contact；
          //  3) 注入一套正式的安装向导 UI（欢迎页/完成页展示开发者、版本与
          //     联系邮箱；证书数字签名需真实证书支持，本版不做伪造展示）。
          //  4) 统一安装向导/进度页/卸载入口中的产品显示名，去掉
          //     “ (Machine)”后缀，界面更整洁。
          const origCreate = creator.create.bind(creator);
          creator.create = async () => {
            const result = await origCreate();
            const wxs = creator.wxsFile;
            if (wxs && typeof wxs === 'string') {
              const fs = require('fs');
              let content = fs.readFileSync(wxs, 'utf8');
              content = content.replace(
                /(Language="\d+")>/,
                '$1 Codepage="936">'
              );
              content = content.replace(
                /<RegistryValue Name="DisplayName"[^>]*\/>/,
                (match) =>
                  `${match}\n              <RegistryValue Name="Contact" Type="string" Value="${DEVELOPER_CONTACT}" KeyPath="no"/>`
              );
              // 产品显示名统一为应用名（去掉 scope 后缀，界面更干净）
              content = content.split(' (Machine - MSI)').join('');
              content = content.split(' (Machine)').join('');

              // 移除 electron-wix-msi 替换「{{UI}}」时写入的默认向导
              // （ui.template 留空在 v5.1.3 会回退到内置 UI 模板，若不删除，
              //   它会与下方注入的自定义向导产生重复符号 LGHT0091）。
              content = content.replace(
                /<UI Id="UserInterface">[\s\S]*?<\/UI>\s*<UIRef Id="WixUI_Common" \/>/,
                ''
              );

              // 注入自定义的正式安装向导 UI
              const anchor = '    <!-- Step 2: Add files and directories -->';
              const uiIndex = content.indexOf(anchor);
              if (uiIndex !== -1) {
                const customUI = buildWixUI(creator);
                content =
                  content.slice(0, uiIndex) +
                  '\n' +
                  customUI +
                  '\n\n' +
                  content.slice(uiIndex);
              }
              fs.writeFileSync(wxs, content, 'utf8');
            }
            return result;
          };
        },
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
        // If you are familiar with Vite configuration, it will look really familiar.
        build: [
          {
            // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
