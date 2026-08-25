const statusEl = document.getElementById('status');
const tbody = document.querySelector('#groupsTable tbody');
const updatedEl = document.getElementById('updated');
const followResultEl = document.getElementById('followResult');

async function getActiveGmgnTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('gmgn.ai')) return tab;
  return null;
}

async function loadState() {
  const res = await chrome.storage.local.get('gmgn');
  const state = res.gmgn;

  tbody.innerHTML = '';

  if (!state || !state.loaded || !state.groups || !state.groups.length) {
    statusEl.textContent = 'Группы еще не перехвачены. Откройте https://gmgn.ai/follow?chain=robinhood';
    statusEl.className = 'status warn';
    updatedEl.textContent = '';
    return;
  }

  statusEl.textContent = `Групп получено: ${state.groups.length}`;
  statusEl.className = 'status ok';

  state.groups.forEach((g) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${g.name}</td><td>${g.chain}</td><td>${g.walletNums ?? ''}</td>`;
    tbody.appendChild(tr);
  });

  updatedEl.textContent = state.updated
    ? `Обновлено: ${new Date(state.updated).toLocaleString()}`
    : '';
}

async function refresh() {
  const tab = await getActiveGmgnTab();
  if (!tab) {
    statusEl.textContent = 'Откройте вкладку на gmgn.ai, чтобы обновить группы';
    statusEl.className = 'status warn';
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.GMGN && window.GMGN.refreshGroups()
  });
  setTimeout(loadState, 600);
}

async function testFollow() {
  const wallet = document.getElementById('walletInput').value.trim();
  followResultEl.textContent = '';
  if (!wallet) return;

  const tab = await getActiveGmgnTab();
  if (!tab) {
    followResultEl.textContent = 'Откройте вкладку на gmgn.ai';
    return;
  }

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (addr) => {
      try {
        const r = await window.GMGN.follow(addr);
        return { ok: true, r };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    args: [wallet]
  });

  followResultEl.textContent = result ? JSON.stringify(result) : 'Нет ответа';
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('followBtn').addEventListener('click', testFollow);

loadState();
