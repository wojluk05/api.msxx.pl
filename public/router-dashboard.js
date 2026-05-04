let refreshIntervalId = null;

const elements = {
    authScreen: document.getElementById('auth-screen'),
    dashboard: document.getElementById('dashboard'),
    authError: document.getElementById('auth-error'),
    passwordInput: document.getElementById('app-pwd'),
    loginButton: document.getElementById('login-btn'),
    logoutButton: document.getElementById('logout-btn'),
    refreshButton: document.getElementById('refresh-btn'),
    heroState: document.getElementById('hero-state'),
    summaryGrid: document.getElementById('summary-grid'),
    keysGrid: document.getElementById('keys-grid'),
    refreshMeta: document.getElementById('refresh-meta'),
    bestKeyPill: document.getElementById('best-key-pill')
};

function formatNumber(value) {
    if (value === null || value === undefined) {
        return 'brak';
    }

    return Number(value).toLocaleString('pl-PL', {
        maximumFractionDigits: 4
    });
}

function formatRelativeTime(timestamp) {
    if (!timestamp) {
        return 'brak danych';
    }

    const diffMs = Date.now() - timestamp;
    const diffSeconds = Math.max(1, Math.round(diffMs / 1000));

    if (diffSeconds < 60) {
        return `${diffSeconds}s temu`;
    }

    const diffMinutes = Math.round(diffSeconds / 60);
    if (diffMinutes < 60) {
        return `${diffMinutes} min temu`;
    }

    const diffHours = Math.round(diffMinutes / 60);
    return `${diffHours} h temu`;
}

function formatDate(value) {
    if (!value) {
        return 'brak';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toLocaleString('pl-PL');
}

function getFillAngle(limit, remaining) {
    const safeRemaining = Math.max(0, Number(remaining || 0));
    const ratio = Math.min(1, safeRemaining / 2000);
    return `${Math.round(ratio * 360)}deg`;
}

function getStatusTone(item) {
    if (item.status === 'error') {
        return 'text-red-300 bg-red-400/10 border-red-400/20';
    }

    if (item.remaining === null) {
        return 'text-emerald-200 bg-emerald-400/10 border-emerald-400/20';
    }

    if (Number(item.remaining) <= 100) {
        return 'text-amber-200 bg-amber-400/10 border-amber-400/20';
    }

    return 'text-teal-200 bg-teal-400/10 border-teal-400/20';
}

function showDashboard() {
    elements.authScreen.classList.add('hidden');
    elements.dashboard.classList.remove('hidden');
    setTimeout(() => elements.dashboard.classList.remove('opacity-0'), 40);
}

function showAuth() {
    elements.authScreen.classList.remove('hidden');
    elements.dashboard.classList.add('hidden');
    elements.dashboard.classList.add('opacity-0');
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
}

function logout() {
    localStorage.removeItem('dash_pwd');
    window.dashboardPassword = '';
    elements.passwordInput.value = '';
    showAuth();
}

async function fetchStatus(forceRefresh = false) {
    const response = await fetch(`/api/status${forceRefresh ? '?refresh=1' : ''}`, {
        method: forceRefresh ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            'x-app-password': window.dashboardPassword
        }
    });

    if (response.status === 401) {
        elements.authError.classList.remove('hidden');
        logout();
        return null;
    }

    if (!response.ok) {
        throw new Error('Nie udalo sie pobrac statusu kluczy.');
    }

    return response.json();
}

function renderHero(bestKey) {
    if (!bestKey) {
        elements.bestKeyPill.classList.add('hidden');
        elements.heroState.innerHTML = `
            <div class="metric-ring rounded-full w-40 h-40 mx-auto p-[10px]" style="--fill: 0deg">
                <div class="w-full h-full rounded-full bg-slate-950/90 flex items-center justify-center flex-col text-center px-6">
                    <p class="text-xs uppercase tracking-[0.3em] text-slate-400">stan</p>
                    <p class="text-lg font-bold text-white mt-2">brak danych</p>
                </div>
            </div>
            <div class="space-y-4">
                <p class="text-slate-300 text-lg">Brak zdrowego klucza. Sprawdz env WEBSCRAPINGAI_KEY_* w Vercel i wykonaj reczne odswiezenie.</p>
            </div>
        `;
        return;
    }

    elements.bestKeyPill.classList.remove('hidden');
    elements.heroState.innerHTML = `
        <div class="metric-ring rounded-full w-40 h-40 mx-auto p-[10px]" style="--fill: ${getFillAngle(bestKey.limit, bestKey.remaining)}">
            <div class="w-full h-full rounded-full bg-slate-950/90 flex items-center justify-center flex-col text-center px-4">
                <p class="text-xs uppercase tracking-[0.3em] text-slate-400">remaining</p>
                <p class="text-2xl font-extrabold text-white mt-2">${formatNumber(bestKey.remaining)}</p>
                <p class="text-xs text-slate-400 mt-1">proxy residential • js true</p>
            </div>
        </div>
        <div class="space-y-5">
            <div>
                <p class="text-xs uppercase tracking-[0.3em] text-slate-400">Wybrany klucz</p>
                <h3 class="text-3xl font-bold text-white mt-2">${bestKey.label}</h3>
                <p class="text-slate-400 mt-2">${bestKey.envName} • ${bestKey.keyPreview}</p>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div class="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <p class="text-[11px] uppercase tracking-[0.3em] text-slate-400">Concurrency</p>
                    <p class="text-2xl font-bold text-white mt-2">${formatNumber(bestKey.remainingConcurrency)}</p>
                </div>
                <div class="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <p class="text-[11px] uppercase tracking-[0.3em] text-slate-400">Ostatni sync</p>
                    <p class="text-2xl font-bold text-white mt-2">${formatRelativeTime(bestKey.updatedAt)}</p>
                </div>
            </div>
        </div>
    `;
}

function renderSummary(data) {
    const items = [
        { label: 'Skonfigurowane klucze', value: data.configuredKeyCount },
        { label: 'Zdrowe klucze', value: data.healthyKeyCount },
        { label: 'Proxy', value: data.forcedRequestConfig?.proxy || 'brak' },
        { label: 'JS', value: data.forcedRequestConfig?.js ? 'true' : 'false' }
    ];

    elements.summaryGrid.innerHTML = items.map((item) => `
        <div class="rounded-3xl border border-white/10 bg-black/20 p-4">
            <p class="text-[11px] uppercase tracking-[0.3em] text-slate-400">${item.label}</p>
            <p class="text-2xl font-bold text-white mt-3">${item.value}</p>
        </div>
    `).join('');

    elements.refreshMeta.textContent = `Ostatnie pelne odswiezenie: ${formatDate(data.lastRefreshAt)}`;
}

function renderKeys(keys, bestKeyId) {
    elements.keysGrid.innerHTML = keys.map((item) => {
        const isBest = item.id === bestKeyId;
        const remainingText = item.remaining === null ? 'brak' : formatNumber(item.remaining);
        const concurrencyText = item.remainingConcurrency === null ? 'brak' : formatNumber(item.remainingConcurrency);

        return `
            <article class="rounded-[26px] border border-white/10 bg-black/20 p-5 hover:border-white/20 transition-all">
                <div class="flex items-start justify-between gap-3 mb-5">
                    <div>
                        <div class="flex flex-wrap items-center gap-2 mb-2">
                            <h3 class="text-xl font-bold text-white">${item.label}</h3>
                            ${isBest ? '<span class="text-[11px] uppercase tracking-[0.3em] px-2 py-1 rounded-full bg-teal-400/10 text-teal-200 border border-teal-300/20">aktywny wybor</span>' : ''}
                        </div>
                        <p class="text-slate-400 text-sm">${item.envName} • ${item.keyPreview}</p>
                    </div>
                    <span class="text-[11px] uppercase tracking-[0.3em] px-3 py-2 rounded-full border ${getStatusTone(item)}">${item.status}</span>
                </div>
                <div class="grid grid-cols-2 gap-3 mb-4">
                    <div class="rounded-2xl border border-white/10 p-3 bg-slate-950/60">
                        <p class="text-[11px] uppercase tracking-[0.3em] text-slate-400">Remaining</p>
                        <p class="text-xl font-bold text-white mt-2">${remainingText}</p>
                    </div>
                    <div class="rounded-2xl border border-white/10 p-3 bg-slate-950/60">
                        <p class="text-[11px] uppercase tracking-[0.3em] text-slate-400">Concurrency</p>
                        <p class="text-xl font-bold text-white mt-2">${concurrencyText}</p>
                    </div>
                    <div class="rounded-2xl border border-white/10 p-3 bg-slate-950/60">
                        <p class="text-[11px] uppercase tracking-[0.3em] text-slate-400">Last credits used</p>
                        <p class="text-xl font-bold text-white mt-2">${formatNumber(item.lastCreditsUsed)}</p>
                    </div>
                    <div class="rounded-2xl border border-white/10 p-3 bg-slate-950/60">
                        <p class="text-[11px] uppercase tracking-[0.3em] text-slate-400">Reset</p>
                        <p class="text-base font-bold text-white mt-2">${item.resetsAt ? formatDate(item.resetsAt) : 'brak'}</p>
                    </div>
                </div>
                <div class="flex items-center justify-between gap-3 text-sm text-slate-400 border-t border-white/10 pt-4">
                    <span>Sync: ${formatRelativeTime(item.updatedAt)}</span>
                    <span>${item.error || `target status ${item.lastTargetStatus ?? 'brak'}`}</span>
                </div>
            </article>
        `;
    }).join('');
}

async function refreshDashboard(forceRefresh = false) {
    if (!window.dashboardPassword) {
        return;
    }

    elements.refreshButton.disabled = true;
    elements.refreshButton.classList.add('opacity-60');

    try {
        const data = await fetchStatus(forceRefresh);
        if (!data) {
            return;
        }

        renderHero(data.bestKey);
        renderSummary(data);
        renderKeys(data.keys || [], data.bestKey?.id);
        lucide.createIcons();
    } catch (error) {
        elements.keysGrid.innerHTML = `<div class="rounded-3xl border border-red-400/20 bg-red-500/10 p-5 text-red-100">${error.message}</div>`;
    } finally {
        elements.refreshButton.disabled = false;
        elements.refreshButton.classList.remove('opacity-60');
    }
}

async function login() {
    const value = elements.passwordInput.value.trim();
    if (!value) {
        return;
    }

    window.dashboardPassword = value;
    localStorage.setItem('dash_pwd', value);
    elements.authError.classList.add('hidden');

    try {
        await refreshDashboard(true);
        showDashboard();

        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
        }

        refreshIntervalId = setInterval(() => {
            refreshDashboard(false);
        }, 60_000);
    } catch {
        elements.authError.classList.remove('hidden');
        logout();
    }
}

elements.loginButton.addEventListener('click', login);
elements.logoutButton.addEventListener('click', logout);
elements.refreshButton.addEventListener('click', () => refreshDashboard(true));
elements.passwordInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        login();
    }
});

if (window.dashboardPassword) {
    showDashboard();
    refreshDashboard(true);
    refreshIntervalId = setInterval(() => {
        refreshDashboard(false);
    }, 60_000);
} else {
    showAuth();
}

lucide.createIcons();