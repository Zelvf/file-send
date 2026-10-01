# File Send

Send files between Windows computers and phones connected to the **same Wi-Fi or local network**. The Windows computer running the app stores the files in its `received` folder. Other devices use a browser; they do not need an app installed.

## Start on Windows

1. Install [Node.js](https://nodejs.org/) if it is not already installed.
2. Double-click `start.cmd` in this folder. Keep the black window open.
3. Open `http://localhost:8787` on that computer and enter the 8-digit access code shown in the black window.
4. On your phone or another computer, connect to the same Wi-Fi and open one of the **Other devices** addresses shown in the black window or the app. Enter the same code.
5. Choose files on either device. They appear in the shared list, where other connected devices can download them.

While a file uploads or downloads, every connected device shows its live progress. The transfer status remains visible briefly after it finishes. Keep the app page open to see updates.

If Windows asks, allow Node.js on **Private networks**. If a phone cannot connect, check that both devices are on the same local network, turn off guest Wi-Fi or client isolation, and use the laptop's Wi-Fi IPv4 address. The app needs the host computer awake and `start.cmd` running.

`npm.cmd start` also starts the app. Set `PORT` to use a different port. `FILE_SEND_CODE` can set a fixed code if desired; use a long random value and keep it private.

## Stop or restart

Double-click `stop.cmd` in this folder to stop the server, even if you lost the access code or the original black window. Then double-click `start.cmd` to get a new code. You can also press **Ctrl+C** in the original window. If `stop.cmd` says the server was started before it was added, use the PowerShell command below once, then start it again:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
```

This is a **local network** app. Devices in different homes or on mobile data cannot reach it merely because both have internet. Transfers use ordinary HTTP on your trusted local network, so do not use it on public Wi-Fi. Delete a file in the app to remove it from the host computer.
