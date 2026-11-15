/* Gravity League - two models play Connect Four. Static, no backend. */
const GEN = "https://gen.pollinations.ai";
const KEY_STORE = "gravityLeague.key";
const RED_STORE = "gravityLeague.red";
const YELLOW_STORE = "gravityLeague.yellow";
const WIDTH = 7;
const HEIGHT = 6;
const REQUEST_TIMEOUT_MS = 45_000;
const DEMO_DELAY_MS = 520;

const FALLBACK_MODELS = [
    { id: "openai/gpt-5.4-nano", title: "GPT-5.4 Nano", reasoning: true },
    { id: "openai/gpt-5.4", title: "GPT-5.4", reasoning: true },
    { id: "openai/gpt-5-nano", title: "GPT-5 Nano", reasoning: true },
    { id: "meta/llama-3.3-70b-instruct", title: "Llama 3.3 70B", reasoning: false },
    { id: "openai/gpt-oss-20b", title: "GPT-OSS 20B", reasoning: false },
    { id: "z-ai/glm-5.3-flash", title: "GLM 5.3 Flash", reasoning: true },
    { id: "deepseek/deepseek-v4.1-flash", title: "DeepSeek V4.1 Flash", reasoning: true },
    { id: "minimax/minimax-m3.1-flash", title: "MiniMax M3.1 Flash", reasoning: true },
];

const $ = (id) => document.getElementById(id);

const state = {
    key: localStorage.getItem(KEY_STORE) || "",
    models: FALLBACK_MODELS,
    players: {
        red: { model: "", name: "Demo bot" },
        yellow: { model: "", name: "Demo bot" },
    },
    score: { red: 0, yellow: 0, draw: 0 },
    board: emptyBoard(),
    current: "red",
    running: false,
    busy: false,
    mode: "idle",
    matchId: 0,
    timer: null,
    move: 0,
};

function emptyBoard() {
    return Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
}

function other(color) {
    return color === "red" ? "yellow" : "red";
}

function colorLabel(color) {
    return color === "red" ? "Red" : "Yellow";
}

function legalMoves(board = state.board) {
    const moves = [];
    for (let col = 0; col < WIDTH; col++) {
        if (board[HEIGHT - 1][col] === null) moves.push(col);
    }
    return moves;
}

function dropRow(board, col) {
    for (let row = 0; row < HEIGHT; row++) {
        if (board[row][col] === null) return row;
    }
    return -1;
}

function lineThrough(board, row, col, color) {
    const directions = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
    ];
    for (const [dr, dc] of directions) {
        const cells = [[row, col]];
        for (const sign of [1, -1]) {
            let r = row + dr * sign;
            let c = col + dc * sign;
            while (
                r >= 0 &&
                r < HEIGHT &&
                c >= 0 &&
                c < WIDTH &&
                board[r][c] === color
            ) {
                cells.push([r, c]);
                r += dr * sign;
                c += dc * sign;
            }
        }
        if (cells.length >= 4) return cells;
    }
    return null;
}

function isFull(board = state.board) {
    return board[HEIGHT - 1].every((cell) => cell !== null);
}

function wouldWin(board, col, color) {
    const row = dropRow(board, col);
    if (row < 0) return false;
    board[row][col] = color;
    const win = Boolean(lineThrough(board, row, col, color));
    board[row][col] = null;
    return win;
}

function chooseHeuristic(board, color) {
    const legal = legalMoves(board);
    if (legal.length === 0) return -1;

    for (const col of legal) {
        if (wouldWin(board, col, color)) return col;
    }
    for (const col of legal) {
        if (wouldWin(board, col, other(color))) return col;
    }

    const centerFirst = [3, 2, 4, 1, 5, 0, 6];
    let best = legal[0];
    let bestScore = -Infinity;
    for (const col of legal) {
        const row = dropRow(board, col);
        let score = 6 - centerFirst.indexOf(col);
        for (const [dr, dc] of [
            [0, 1],
            [1, 0],
            [1, 1],
            [1, -1],
        ]) {
            for (const sign of [1, -1]) {
                const r = row + dr * sign;
                const c = col + dc * sign;
                if (r >= 0 && r < HEIGHT && c >= 0 && c < WIDTH) {
                    if (board[r][c] === color) score += 2;
                    if (board[r][c] === other(color)) score += 1;
                }
            }
        }
        if (score > bestScore) {
            bestScore = score;
            best = col;
        }
    }
    return best;
}

function boardText(board) {
    const rows = [];
    for (let row = HEIGHT - 1; row >= 0; row--) {
        rows.push(
            board[row]
                .map((cell) => (cell === "red" ? "R" : cell === "yellow" ? "Y" : "."))
                .join(" "),
        );
    }
    return rows.join("\n");
}

function systemPrompt() {
    return [
        "You are playing Connect Four on a 7-column by 6-row board.",
        "R is a red disc, Y is a yellow disc, and . is an empty cell.",
        "The board is shown with the top row first. Discs fall to the lowest empty cell in the chosen column.",
        "Red and Yellow alternate, and Red moves first.",
        "Choose one legal column and reply with exactly one digit from 1 to 7. Do not explain, do not use markdown.",
    ].join(" ");
}

function userPrompt(board, color) {
    const legal = legalMoves(board).map((col) => col + 1);
    return [
        "Board (top row first):",
        boardText(board),
        "",
        `${colorLabel(color)} to move.`,
        `Legal columns: ${legal.join(", ")}.`,
        "Reply with one digit from 1 to 7.",
    ].join("\n");
}

async function askModel(player, board, color) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        // reasoning_effort "none" keeps reasoning models fast; models without
        // reasoning reject the parameter, so only send it when they declare it.
        const reasoningModel = state.models.find(
            (model) => model.id === player.model,
        )?.reasoning;
        const response = await fetch(`${GEN}/v1/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${state.key}`,
                "Content-Type": "application/json",
            },
            signal: controller.signal,
            body: JSON.stringify({
                model: player.model,
                messages: [
                    { role: "system", content: systemPrompt() },
                    { role: "user", content: userPrompt(board, color) },
                ],
                max_tokens: 16,
                temperature: 0.2,
                ...(reasoningModel ? { reasoning_effort: "none" } : {}),
            }),
        });
        const raw = await response.text();
        let data = null;
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error(`HTTP ${response.status}: ${raw.slice(0, 80)}`);
        }
        if (!response.ok) {
            throw new Error(
                data?.error?.message || `HTTP ${response.status}`,
            );
        }
        let content = data?.choices?.[0]?.message?.content;
        if (Array.isArray(content)) {
            content = content.map((part) => part?.text || "").join(" ");
        }
        const match = String(content || "").match(/\b([1-7])\b/);
        if (!match) {
            throw new Error(
                `reply was not a column: ${String(content || "").slice(0, 60)}`,
            );
        }
        const col = Number(match[1]) - 1;
        if (!legalMoves(board).includes(col)) {
            throw new Error(`reply chose a full column: ${col + 1}`);
        }
        return col;
    } finally {
        clearTimeout(timer);
    }
}

function setBanner(text, variant = "") {
    const banner = $("turnBanner");
    banner.textContent = text;
    banner.className = `turn-banner ${variant}`.trim();
}

function setStatus(text, isError = false) {
    const line = $("statusLine");
    line.textContent = text;
    line.classList.toggle("error", isError);
}

function updateScoreboard() {
    $("redName").textContent = state.players.red.name;
    $("yellowName").textContent = state.players.yellow.name;
    $("redScore").textContent = String(state.score.red);
    $("yellowScore").textContent = String(state.score.yellow);
    $("drawScore").textContent = `Draws ${state.score.draw}`;
}

function buildBoard() {
    const boardEl = $("board");
    boardEl.replaceChildren();
    for (let row = HEIGHT - 1; row >= 0; row--) {
        for (let col = 0; col < WIDTH; col++) {
            const cell = document.createElement("div");
            cell.className = "board-cell";
            cell.dataset.row = String(row);
            cell.dataset.col = String(col);
            cell.setAttribute("role", "gridcell");
            cell.setAttribute(
                "aria-label",
                `row ${HEIGHT - row}, column ${col + 1}`,
            );
            boardEl.appendChild(cell);
        }
    }
}

function renderBoard(animate = null) {
    const boardEl = $("board");
    const cells = boardEl.children;
    let index = 0;
    for (let row = HEIGHT - 1; row >= 0; row--) {
        for (let col = 0; col < WIDTH; col++) {
            const cell = cells[index++];
            const value = state.board[row][col];
            cell.replaceChildren();
            cell.classList.remove("win");
            if (value) {
                const disc = document.createElement("span");
                disc.className = `disc ${value}`;
                if (animate && animate.row === row && animate.col === col) {
                    disc.classList.add("drop");
                    disc.style.setProperty("--rows", String(HEIGHT - row));
                }
                cell.appendChild(disc);
            }
        }
    }
}

function renderColumnButtons() {
    const container = $("columnButtons");
    container.replaceChildren();
    const canPlay =
        state.running && !state.busy && state.mode === "model";
    for (let col = 0; col < WIDTH; col++) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "column-button";
        button.dataset.col = String(col);
        button.textContent = String(col + 1);
        button.setAttribute("aria-label", `Drop in column ${col + 1}`);
        button.disabled = !canPlay || dropRow(state.board, col) < 0;
        container.appendChild(button);
    }
}

function addLog(text, variant = "") {
    const item = document.createElement("li");
    if (variant) item.className = variant;
    item.textContent = text;
    const log = $("moveLog");
    log.appendChild(item);
    $("moveCount").textContent = `${state.move} move${state.move === 1 ? "" : "s"}`;
    log.scrollTop = log.scrollHeight;
}

function clearLog() {
    $("moveLog").replaceChildren();
    $("moveCount").textContent = "0 moves";
}

function setModelsDisabled(disabled) {
    $("redModel").disabled = disabled;
    $("yellowModel").disabled = disabled;
    $("startButton").disabled = disabled;
    $("demoButton").disabled = disabled;
}

function startMatch(mode) {
    if (mode === "model" && !state.key) {
        setStatus("Connect a Pollinations key first, or watch the demo.");
        openKeyDialog();
        return;
    }

    const redSelect = $("redModel");
    const yellowSelect = $("yellowModel");
    const redModel = redSelect.value || state.models[0]?.id;
    const yellowModel = yellowSelect.value || state.models[1]?.id || state.models[0]?.id;
    if (mode === "model" && (!redModel || !yellowModel)) {
        setStatus("No text models are available. Try again in a moment.", true);
        return;
    }

    window.clearTimeout(state.timer);
    state.matchId += 1;
    const matchId = state.matchId;
    state.board = emptyBoard();
    state.current = "red";
    state.running = true;
    state.busy = false;
    state.mode = mode;
    state.move = 0;
    state.players = {
        red: {
            model: redModel || "",
            name:
                mode === "demo"
                    ? "Demo Red"
                    : modelName(redModel),
        },
        yellow: {
            model: yellowModel || "",
            name:
                mode === "demo"
                    ? "Demo Yellow"
                    : modelName(yellowModel),
        },
    };
    localStorage.setItem(RED_STORE, redModel || "");
    localStorage.setItem(YELLOW_STORE, yellowModel || "");

    clearLog();
    updateScoreboard();
    buildBoard();
    renderBoard();
    renderColumnButtons();
    setModelsDisabled(true);
    setStatus(
        mode === "demo"
            ? "Local demo: two heuristic players, no model calls, no Pollen."
            : "Each move is one short model call, paid by your key.",
    );
    setBanner(
        mode === "demo" ? "Demo match - local players" : "Red to move",
        "red",
    );
    scheduleTurn(matchId, mode === "demo" ? DEMO_DELAY_MS : 280);
}

function scheduleTurn(matchId, delay) {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
        if (state.matchId !== matchId || !state.running) return;
        takeTurn(matchId);
    }, delay);
}

async function takeTurn(matchId) {
    if (!state.running || state.busy) return;
    const color = state.current;
    const player = state.players[color];

    if (state.mode === "demo") {
        const col = chooseHeuristic(state.board, color);
        if (state.matchId === matchId) applyMove(col, color, "demo", "");
        return;
    }

    state.busy = true;
    setBanner(`${colorLabel(color)} - ${player.name} is thinking`, `${color} thinking`);
    setStatus(`Waiting for ${player.name} to choose a column...`);
    renderColumnButtons();

    let col = null;
    let note = "";
    try {
        col = await askModel(player, state.board, color);
    } catch (error) {
        const message = describeError(error);
        window.__lastGravityError = message;
        note = `local fallback: ${message}`;
        console.warn("Gravity League model move failed", error);
    }

    if (state.matchId !== matchId || !state.running) return;
    state.busy = false;
    if (col === null || !legalMoves(state.board).includes(col)) {
        col = chooseHeuristic(state.board, color);
    }
    applyMove(col, color, state.mode, note);
}

function applyMove(col, color, mode, note) {
    if (!state.running) return;
    const row = dropRow(state.board, col);
    if (row < 0) {
        finishGame("draw", null);
        return;
    }
    state.board[row][col] = color;
    state.move += 1;
    renderBoard({ row, col });
    addLog(
        `${state.move}. ${colorLabel(color)} -> column ${col + 1}${note ? ` (${note})` : ""}`,
        color,
    );

    const line = lineThrough(state.board, row, col, color);
    if (line) {
        finishGame(color, line);
        return;
    }
    if (isFull()) {
        finishGame("draw", null);
        return;
    }

    state.current = other(color);
    const next = state.players[state.current];
    setBanner(
        `${colorLabel(state.current)} - ${next.name} to move`,
        state.current,
    );
    setStatus(
        mode === "demo"
            ? "Local demo: no model calls."
            : `${next.name} is choosing a column...`,
    );
    renderColumnButtons();
    scheduleTurn(
        state.matchId,
        mode === "demo" ? DEMO_DELAY_MS : 260,
    );
}

function finishGame(result, line) {
    state.running = false;
    state.busy = false;
    window.clearTimeout(state.timer);
    renderColumnButtons();
    setModelsDisabled(false);

    if (line) {
        for (const [row, col] of line) {
            const cell = $("board").querySelector(
                `[data-row="${row}"][data-col="${col}"]`,
            );
            cell?.classList.add("win");
        }
    }

    if (result === "draw") {
        state.score.draw += 1;
        updateScoreboard();
        setBanner("Draw - the board is full", "over");
        setStatus("No winner. Start a rematch or reset the series.");
        addLog("Draw - the board is full.", "result");
        return;
    }

    state.score[result] += 1;
    updateScoreboard();
    const winner = state.players[result];
    setBanner(`${colorLabel(result)} wins - ${winner.name}`, "over");
    setStatus(
        `${winner.name} connected four. Start a rematch or switch models.`,
    );
    addLog(`${colorLabel(result)} wins - ${winner.name}.`, "result");
}

function describeError(error) {
    if (error?.name === "AbortError") return "request timed out";
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, " ").slice(0, 140);
}

function modelName(id) {
    const found = state.models.find((model) => model.id === id);
    return found?.title || id.split("/").pop() || id;
}

function renderModelOptions() {
    const red = $("redModel");
    const yellow = $("yellowModel");
    const previousRed = localStorage.getItem(RED_STORE);
    const previousYellow = localStorage.getItem(YELLOW_STORE);
    red.replaceChildren();
    yellow.replaceChildren();
    for (const model of state.models) {
        for (const select of [red, yellow]) {
            const option = document.createElement("option");
            option.value = model.id;
            option.textContent = model.title || model.id;
            select.appendChild(option);
        }
    }
    if (state.models.length === 0) {
        for (const select of [red, yellow]) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = "No text models available";
            select.appendChild(option);
        }
        return;
    }
    const ids = new Set(state.models.map((model) => model.id));
    red.value = ids.has(previousRed) ? previousRed : state.models[0].id;
    yellow.value =
        ids.has(previousYellow) && previousYellow !== red.value
            ? previousYellow
            : state.models.find((model) => model.id !== red.value)?.id ||
              state.models[0].id;
}

function preferredOrder(id) {
    const order = FALLBACK_MODELS.map((model) => model.id);
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
}

async function loadModels() {
    const headers = state.key
        ? { Authorization: `Bearer ${state.key}` }
        : undefined;
    try {
        const response = await fetch(
            `${GEN}/v1/models?limit=500&reliability=all`,
            { headers },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const list = Array.isArray(body) ? body : body.data || [];
        const seen = new Set();
        const models = [];
        for (const model of list) {
            if (!model || model.category !== "text" || model.community) {
                continue;
            }
            if (model.paid_only) continue;
            const id = model.id || model.name;
            if (!id || seen.has(id)) continue;
            // Audio-output and specialized classification/art models cannot
            // play a board game; keep the picker to chat models.
            if (model.output_modalities?.includes("audio")) continue;
            if (/guard|midijourney|glyph|codex/i.test(id)) continue;
            seen.add(id);
            models.push({
                id,
                title: model.title || id,
                reasoning: model.reasoning === true,
            });
        }
        models.sort((a, b) => {
            const order = preferredOrder(a.id) - preferredOrder(b.id);
            return order !== 0 ? order : a.title.localeCompare(b.title);
        });
        state.models = models.length >= 2 ? models : FALLBACK_MODELS;
    } catch (error) {
        console.warn("Gravity League model catalog failed", error);
        state.models = FALLBACK_MODELS;
    }
    renderModelOptions();
}

function openKeyDialog() {
    $("keyError").textContent = "";
    $("keyInput").value = "";
    $("keyDialog").showModal();
    setTimeout(() => $("keyInput").focus(), 20);
}

function updateKeyUi() {
    const stateLabel = $("keyState");
    stateLabel.textContent = state.key ? "Key connected" : "Demo mode";
    stateLabel.classList.toggle("connected", Boolean(state.key));
    $("connectButton").hidden = Boolean(state.key);
    $("disconnectButton").hidden = !state.key;
}

async function saveKey() {
    const key = $("keyInput").value.trim();
    const errorEl = $("keyError");
    if (!key) {
        errorEl.textContent = "Paste a key first.";
        return;
    }
    const button = $("saveKeyButton");
    button.disabled = true;
    errorEl.textContent = "Checking the key...";
    try {
        const response = await fetch(`${GEN}/v1/models?limit=1`, {
            headers: { Authorization: `Bearer ${key}` },
        });
        if (!response.ok) {
            errorEl.textContent =
                response.status === 401
                    ? "That key was not accepted."
                    : `Could not validate the key (HTTP ${response.status}).`;
            return;
        }
        state.key = key;
        localStorage.setItem(KEY_STORE, key);
        updateKeyUi();
        await loadModels();
        $("keyDialog").close();
        setStatus("Key connected. Pick two models and start a match.");
    } catch (error) {
        errorEl.textContent = `Could not reach the API: ${describeError(error)}`;
    } finally {
        button.disabled = false;
    }
}

function disconnectKey() {
    state.key = "";
    localStorage.removeItem(KEY_STORE);
    updateKeyUi();
    setStatus("Key disconnected. Demo mode still works without Pollen.");
    loadModels();
}

function onColumnClick(event) {
    const button = event.target.closest("button[data-col]");
    if (!button || button.disabled) return;
    if (!state.running || state.busy || state.mode !== "model") return;
    const col = Number(button.dataset.col);
    if (!legalMoves().includes(col)) return;
    // Manual play is intentionally disabled: both sides are models.
}

function bindEvents() {
    $("columnButtons").addEventListener("click", onColumnClick);
    $("startButton").addEventListener("click", () => startMatch("model"));
    $("demoButton").addEventListener("click", () => startMatch("demo"));
    $("resetButton").addEventListener("click", () => {
        if (state.running) return;
        state.score = { red: 0, yellow: 0, draw: 0 };
        updateScoreboard();
        setStatus("Series reset. Pick two models or watch the demo.");
        setBanner("Ready for a new series", "over");
    });
    $("connectButton").addEventListener("click", openKeyDialog);
    $("disconnectButton").addEventListener("click", disconnectKey);
    $("saveKeyButton").addEventListener("click", saveKey);
    $("keyInput").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            saveKey();
        }
    });
    $("keyDialog").addEventListener("close", () => {
        $("keyError").textContent = "";
    });
}

function init() {
    bindEvents();
    buildBoard();
    renderBoard();
    renderColumnButtons();
    renderModelOptions();
    updateKeyUi();
    updateScoreboard();
    setBanner("Demo mode - press Watch demo", "");
    setStatus("Connect a key to play two models, or watch the demo.");
    // The bundled list renders immediately; the live catalog can refresh it
    // later without delaying the zero-Pollen sample.
    loadModels();
    const params = new URLSearchParams(location.search);
    const sample = params.get("sample") === "1";
    if (sample) {
        setStatus("Sample match: local demo, no key and no Pollen.");
        startMatch("demo");
    } else if (params.get("play") === "1" && state.key) {
        setStatus("Starting a model match from the deep link...");
        startMatch("model");
    }
}

init();
