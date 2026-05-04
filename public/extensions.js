// Tab and Bulk functionality extension

let tabs = JSON.parse(localStorage.getItem('api_monitor_tabs') || '["Wszystkie"]');
let activeTab = "Wszystkie";

function initTabs() {
    renderTabs();
    
    // Nadpiszmy funkcję refreshAll z index.html, 
    // aby uwzględniała filtrowanie po aktywnej zakładce.
    const originalRefreshAll = window.refreshAll;
    window.refreshAll = async function() {
        if (!dashboardPassword) return;

        const container = document.getElementById('cards-container');
        container.innerHTML = ''; 

        // Filtrowanie kluczy na podstawie aktywnej zakładki
        const filteredKeys = window.keys.filter(k => {
            if (activeTab === "Wszystkie") return true;
            return (k.tab === activeTab) || (!k.tab && activeTab === "Główne");
        });

        for (const item of filteredKeys) {
            const card = document.createElement('div');
            card.className = 'glass-card p-6 rounded-3xl relative group border border-transparent hover:border-slate-700 transition-all';
            card.innerHTML = `<div class="animate-pulse flex flex-col gap-4"><div class="h-4 bg-slate-800 rounded w-1/2"></div></div>`;
            container.appendChild(card);

            const data = await fetchStats(item);
            if (!data) continue; 

            const limit = data?.limit || 0;
            const used = data?.used || 0;
            const remaining = data?.remaining || 0;
            const percent = limit > 0 ? (used / limit) * 100 : 0;
            const colorClass = percent > 90 ? 'bg-red-500' : (percent > 70 ? 'bg-amber-500' : 'bg-blue-500');

            card.innerHTML = `
                <button onclick="removeKey(${item.id})" class="absolute top-4 right-4 opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-500 transition-all">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
                <div class="flex items-center gap-3 mb-8">
                    <div class="w-10 h-10 bg-slate-800 rounded-xl flex items-center justify-center border border-slate-700">
                        <i data-lucide="${item.type === 'scraperapi' ? 'layers' : 'zap'}" class="text-blue-400 w-5 h-5"></i>
                    </div>
                    <div>
                        <h3 class="font-bold text-white text-sm uppercase tracking-tight">${item.name} ${item.tab ? `<span class="text-[10px] text-slate-500 font-normal ml-2">(${item.tab})</span>` : ''}</h3>
                        <p class="text-[10px] text-slate-500 font-bold">${item.type.toUpperCase()}</p>
                    </div>
                </div>
                <div class="space-y-4">
                    <div class="flex justify-between items-end">
                        <span class="text-4xl font-extrabold text-white leading-none">${remaining.toLocaleString()}</span>
                        ${limit > 0 ? `<span class="text-slate-600 text-[10px] font-bold uppercase mb-1">POZOSTAŁO Z ${limit.toLocaleString()}</span>` : ``}
                    </div>
                    ${limit > 0 ? `
                        <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden border border-slate-700/50">
                            <div class="${colorClass} h-full transition-all duration-1000" style="width: ${percent}%"></div>
                        </div>
                        <div class="flex justify-between text-[10px] font-bold uppercase text-slate-500 tracking-widest">
                            <span>ZUŻYCIE</span><span>${percent.toFixed(1)}%</span>
                        </div>
                    ` : ``}
                    <div class="pt-4 mt-2 border-t border-slate-800/50 flex justify-between items-center key-row">
                        <span class="text-[9px] text-slate-600 font-bold uppercase tracking-wider">Klucz API</span>
                        <div class="flex gap-2.5 items-center">
                            <span class="mangled-key text-xs">${item.key.substring(0, 10)}******************</span>
                            <button onclick="copyKey(${item.id}, this)" class="bg-slate-800 hover:bg-slate-700/70 p-1.5 rounded-lg border border-slate-700/30 transition-all">
                                <i data-lucide="clipboard" class="text-slate-600 group-hover:text-blue-400 w-4 h-4 transition-colors"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
            lucide.createIcons();
        }
    };
}

function updateTabDropdowns() {
    ['bulkTab', 'singleTab'].forEach(id => {
        const el = document.getElementById(id);
        if(!el) return;
        el.innerHTML = '<option value="">Główne</option>';
        tabs.forEach(t => {
            if(t !== "Wszystkie" && t !== "Główne") {
                el.innerHTML += `<option value="${t}">${t}</option>`;
            }
        });
        el.innerHTML += '<option value="__NEW__">+ Nowa zakładka (wpisz niżej)</option>';
    });
}

function renderTabs() {
    let html = '<div class="flex gap-2 p-2 bg-slate-800/50 rounded-2xl mb-6 overflow-x-auto border border-slate-700/50">';
    tabs.forEach(t => {
        const active = (t === activeTab);
        html += `<button onclick="switchTab('${t}')" class="px-5 py-2 rounded-xl text-sm font-bold transition-all ${active ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:text-white hover:bg-slate-800'}">${t}</button>`;
    });
    html += '</div>';
    
    let tabsContainer = document.getElementById('tabs-container');
    if(tabsContainer) {
        tabsContainer.innerHTML = html;
        updateTabDropdowns();
    }
}

window.switchTab = function(t) {
    activeTab = t;
    renderTabs();
    window.refreshAll();
};

window.toggleBulkModal = function() {
    document.getElementById('bulk-modal').classList.toggle('hidden');
    updateTabDropdowns();
};

window.handleTabSelectChange = function(event, newTabInputId) {
    if(event.target.value === '__NEW__') {
        document.getElementById(newTabInputId).classList.remove('hidden');
    } else {
        document.getElementById(newTabInputId).classList.add('hidden');
    }
};

window.processBulkTxtFile = async function() {
    const fileInput = document.getElementById('bulk-file');
    const serviceType = document.getElementById('bulk-type').value;
    const tabSelect = document.getElementById('bulkTab').value;
    const newTabName = document.getElementById('bulkNewTabName').value.trim();

    if (!fileInput.files.length) {
        alert("Wybierz plik TXT!");
        return;
    }

    let targetTab = tabSelect;
    if (tabSelect === '__NEW__') {
        if (!newTabName) {
            alert("Podaj nazwę nowej zakładki!");
            return;
        }
        if (!tabs.includes(newTabName)) {
            tabs.push(newTabName);
            localStorage.setItem('api_monitor_tabs', JSON.stringify(tabs));
        }
        targetTab = newTabName;
    } else if (tabSelect === "") {
        targetTab = "Główne";
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = function(e) {
        const lines = e.target.result.split(/\r?\n/);
        let count = 0;
        let duplicates = 0;
        lines.forEach(line => {
            const tk = line.trim();
            if (tk) {
                const exists = window.keys.some(existingKey => existingKey.key === tk && existingKey.type === serviceType);
                if (!exists) {
                    window.keys.push({ 
                        id: Date.now() + Math.random(), 
                        name: `Masowe ${count+1}`, 
                        type: serviceType, 
                        key: tk,
                        tab: targetTab
                    });
                    count++;
                } else {
                    duplicates++;
                }
            }
        });
        
        localStorage.setItem('api_monitor_keys', JSON.stringify(window.keys));
        alert(`Dodano ${count} nowych kluczy do zakładki: ${targetTab}` + (duplicates > 0 ? `\nPominięto ${duplicates} duplikatów.` : ''));
        window.toggleBulkModal();
        renderTabs();
        window.refreshAll();
    };

    reader.readAsText(file);
};

// Nadpisz usuwanie kluczy (z potwierdzeniem) globalnie
window.removeKey = function(id) {
    if(confirm("Czy na pewno chcesz usunąć to API? Potwierdź swoją decyzję.")) {
        window.keys = window.keys.filter(k => k.id !== id);
        localStorage.setItem('api_monitor_keys', JSON.stringify(window.keys));
        window.refreshAll();
    }
};

// Dodajemy modyfikację do metody saveKey w celu obsługi zakładek
const originalSaveKey = window.saveKey;
window.saveKey = function() {
    const n = document.getElementById('name').value || 'Bez nazwy';
    const t = document.getElementById('type').value;
    const k = document.getElementById('key').value;
    
    let tabSelect = document.getElementById('singleTab').value;
    let newTabName = document.getElementById('singleNewTabName').value.trim();
    
    if(!k) return alert("Klucz jest wymagany!");

    const exists = window.keys.some(existingKey => existingKey.key === k && existingKey.type === t);
    if (exists) {
        return alert("Ten klucz API jest już dodany do systemu!");
    }

    let targetTab = tabSelect;
    if (tabSelect === '__NEW__') {
        if (!newTabName) {
            alert("Podaj nazwę nowej zakładki!");
            return;
        }
        if (!tabs.includes(newTabName)) {
            tabs.push(newTabName);
            localStorage.setItem('api_monitor_tabs', JSON.stringify(tabs));
        }
        targetTab = newTabName;
    } else if (tabSelect === "") {
        targetTab = "Główne";
    }

    window.keys.push({ id: Date.now(), name: n, type: t, key: k, tab: targetTab });
    localStorage.setItem('api_monitor_keys', JSON.stringify(window.keys));
    toggleModal();
    renderTabs();
    window.refreshAll();
};

document.addEventListener('DOMContentLoaded', initTabs);
