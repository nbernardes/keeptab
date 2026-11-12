# KeepTab

Chrome extension that keeps pinned tabs in place. When you're in a pinned tab
and go to a new page (search, link, form, address bar), that page opens in a
**new tab** and the pin stays on its URL.

## Install

KeepTab isn't on the Chrome Web Store, so you load it as an unpacked extension.
It takes about a minute.

### 1. Download the code

Pick one of these:

- **With git** (easier to update later):

  ```sh
  git clone https://github.com/nbernardes/keeptab.git
  ```

- **Without git**: on the [repo page](https://github.com/nbernardes/keeptab),
  click **Code → Download ZIP** and unzip it.

Put the folder somewhere permanent, like `~/Developer/keeptab` or
`Documents/keeptab`. Chrome loads the extension straight from this folder, so
if you move or delete it, the extension stops working.

### 2. Load it in Chrome

1. Type `chrome://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** (switch in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Choose the `keeptab` folder, the one that has `manifest.json` in it.
5. KeepTab now shows up in your extension list. Make sure its switch is on.

### 3. Pin it to the toolbar (optional)

Click the puzzle-piece icon (🧩) next to the address bar, then click the pin
icon next to **KeepTab**. Click the KeepTab icon to open its settings.

### 4. Try it

1. Right-click any tab and choose **Pin**.
2. Click a link or search for something in that tab. It opens in a new tab and
   the pin stays where it was.
3. Close the pinned tab with ⌘W / Ctrl+W. It comes back right away.
4. To get rid of a pin for good: right-click it, choose **Unpin**, then close
   it.

Tabs that were already open before you installed KeepTab are covered right
away. Reloading them isn't needed.

### Updating

- **git**: run `git pull` in the folder.
- **ZIP**: download it again and replace the files in the same folder.

Then go to `chrome://extensions` and click the reload icon (↻) on the KeepTab
card.

### Uninstalling

Go to `chrome://extensions` and click **Remove** on the KeepTab card. You can
delete the folder afterwards.

### Troubleshooting

- **"Manifest file is missing or unreadable"**: you picked the wrong folder.
  Choose the folder that has `manifest.json` directly inside it. ZIP downloads
  often create a nested `keeptab-main/keeptab-main` folder.
- **"Disable developer mode extensions" pop-up when Chrome starts**: this is
  normal for extensions loaded this way. Close it or click **Keep**. Don't
  click **Disable**.
- **Nothing happens in a pinned tab**: extensions can't run on `chrome://`
  pages, the Chrome Web Store, or the New Tab page. Try a normal website.
- **Works in other Chromium browsers**: Edge (`edge://extensions`), Brave
  (`brave://extensions`), Arc and others. The steps are the same.

### Permissions

Chrome will list the permissions KeepTab asks for. Here's why each one is
needed:

| Permission | Why |
| --- | --- |
| Read and change data on all websites | To catch link clicks and searches in pinned tabs and open them in a new tab. |
| `tabs` | To know which tabs are pinned and where they sit in the tab strip. |
| `webNavigation` | To notice when a pinned tab goes to a new page some other way (address bar, scripts). |
| `sessions` | To reopen a closed pinned tab with its history. |
| `storage` | To save your settings. |
| `scripting` | To set up KeepTab in tabs that were open before you installed it. |

KeepTab doesn't collect data, make network requests, or send anything
anywhere. Everything stays in your browser.

## How it works

- **content.js**: in pinned tabs, link clicks and form submits that would load
  a new page are switched to `target="_blank"`. This happens *after* the page's
  own handlers run, so in-app navigation in web apps (Gmail, Slack, Notion…)
  still works inside the pin.
- **background.js**: catches what the content script can't see
  (`location.href = …`, `form.submit()`, typing in the address bar). It opens
  the URL in a new tab and sends the pin back with `goBack`.
- In-page URL changes (`pushState`, `#hash`), reloads, back/forward and
  redirects are never intercepted.
- A pin on the New Tab page or `about:blank` can still go somewhere normally,
  so that's how you set what a pin shows.

### Pinned tabs can't be closed

Chrome has no API to block closing a tab, so when a pinned tab is closed
(⌘W, middle-click, "Close", "Close other tabs"…) KeepTab reopens it right away
from Chrome's recently-closed list. It comes back pinned, in the same spot, with
its history.

To close a pin for good: **right-click → Unpin**, then close it.

This doesn't apply when closing a whole window or quitting Chrome. If a pin is
the only tab in its window, closing it closes the window, so it isn't reopened.

## Settings (toolbar popup)

- **Enabled** on/off
- **Don't let pinned tabs close** on/off
- **Any page change** (default) or **Leaving the site only**
