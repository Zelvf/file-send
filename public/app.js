const $ = id => document.getElementById(id);
const loginCard = $("loginCard");
const workspace = $("workspace");
let transferPollBusy = false;
const seenCompletedUploads = new Set();

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong");
  return data;
}
function size(n) {
  if (n < 1024) return `${n} B`;
  const unit = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
function node(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value !== undefined) el.textContent = value;
  return el;
}
async function refresh() {
  const { files } = await api("/api/files");
  $("files").replaceChildren(...files.map(file => {
    const row = node("div", "file");
    const info = node("div");
    info.append(node("strong", "", file.name), node("div", "sub", `${size(file.size)} · ${new Date(file.createdAt).toLocaleString()}`));
    const actions = node("div", "fileActions");
    const download = node("a", "", "Download");
    download.href = `/api/files/${file.id}`;
    const remove = node("button", "delete", "Delete");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete ${file.name} from this computer?`)) return;
      remove.disabled = true;
      try { await api(`/api/files/${file.id}`, { method: "DELETE" }); await refresh(); }
      catch (error) { alert(error.message); remove.disabled = false; }
    });
    actions.append(download, remove);
    row.append(info, actions);
    return row;
  }));
  $("emptyState").hidden = files.length > 0;
}
async function refreshTransfers() {
  if (workspace.hidden || transferPollBusy) return;
  transferPollBusy = true;
  try {
    const { transfers } = await api("/api/transfers");
    $("transfersCard").hidden = transfers.length === 0;
    $("transfers").replaceChildren(...transfers.map(transfer => {
      const row = node("div", "transferItem");
      const heading = node("div", "transferHeading");
      const direction = transfer.direction === "upload" ? "Sending to this computer" : "Downloading from this computer";
      const state = transfer.state === "done" ? "Complete" : transfer.state === "failed" ? "Interrupted" : direction;
      heading.append(node("strong", "", transfer.name), node("span", "sub", state));
      const total = transfer.total;
      const percent = total ? Math.min(100, Math.round(transfer.transferred / total * 100)) : null;
      const detail = node("div", "transferDetail", `${size(transfer.transferred)}${total ? ` of ${size(total)}` : " transferred"}${percent !== null ? ` · ${percent}%` : ""}`);
      const bar = node("progress", "transferProgress");
      bar.max = 100;
      if (percent !== null) bar.value = transfer.state === "done" ? 100 : percent;
      row.append(heading, detail, bar);
      return row;
    }));
    const completedIds = new Set();
    for (const transfer of transfers) {
      if (transfer.direction === "upload" && transfer.state === "done" && !seenCompletedUploads.has(transfer.id)) {
        refresh().catch(() => {});
      }
      if (transfer.direction === "upload" && transfer.state === "done") completedIds.add(transfer.id);
    }
    seenCompletedUploads.clear();
    for (const id of completedIds) seenCompletedUploads.add(id);
  } catch (error) {
    if (error.message === "Enter the access code first") init();
  } finally { transferPollBusy = false; }
}
async function init() {
  try {
    const status = await api("/api/status");
    loginCard.hidden = status.unlocked;
    workspace.hidden = !status.unlocked;
    if (status.unlocked) {
      $("addresses").replaceChildren(...status.addresses.map(address => {
        const a = node("a", "", address);
        a.href = address;
        return a;
      }));
      await refresh();
      await refreshTransfers();
    }
  } catch (error) { $("loginMessage").textContent = error.message; loginCard.hidden = false; }
}
$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("loginMessage").textContent = "";
  try {
    await api("/api/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: $("code").value }) });
    $("code").value = "";
    await init();
  } catch (error) { $("loginMessage").textContent = error.message; }
});
$("lockButton").addEventListener("click", async () => { await api("/api/lock", { method: "POST" }); await init(); });
$("refreshButton").addEventListener("click", () => refresh().catch(error => alert(error.message)));

function upload(file) {
  return new Promise(resolve => {
    const row = node("div", "uploadItem");
    const info = node("div");
    const status = node("div", "sub", `Sending · ${size(file.size)}`);
    info.append(node("strong", "", file.name), status);
    const progress = node("progress", "progress");
    progress.max = 100;
    progress.value = 0;
    row.append(info, progress);
    $("queue").prepend(row);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/files?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress.value = Math.round(event.loaded / event.total * 100); };
    xhr.onload = () => {
      if (xhr.status === 201) { status.textContent = `Sent · ${size(file.size)}`; progress.value = 100; refresh().catch(() => {}); }
      else { try { status.textContent = JSON.parse(xhr.responseText).error; } catch { status.textContent = "Upload failed"; } }
      resolve();
    };
    xhr.onerror = () => { status.textContent = "Connection lost. Try again."; resolve(); };
    xhr.send(file);
  });
}
let pending = Promise.resolve();
function addFiles(files) {
  for (const file of files) pending = pending.then(() => upload(file));
}
$("fileInput").addEventListener("change", event => { addFiles([...event.target.files]); event.target.value = ""; });
const drop = $("dropZone");
drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", event => { event.preventDefault(); drop.classList.remove("over"); addFiles([...event.dataTransfer.files]); });
init();
setInterval(refreshTransfers, 500);
