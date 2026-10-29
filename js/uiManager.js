// ============================================================================
// Brass: Birmingham - UI Manager
// Enhanced with phase bar, game log, turn transitions, card selection mode
// ============================================================================

class UIManager {
    // Older rooms saved their log lines in English; show them in Chinese.
    static trLog(msg) {
        if (typeof msg !== 'string' || !/[A-Za-z]{3}/.test(msg)) return msg;
        const exact = {
            'Canal Era': '运河时代', 'Rail Era': '铁路时代', 'Canal Era Scoring': '运河时代计分',
            'Final Scoring': '最终计分', 'Canal Era Complete': '运河时代结束', 'Era Scoring': '时代计分',
            'passed': '跳过', 'scouted (gained wild cards)': '侦察（获得万能牌）',
        };
        if (exact[msg]) return exact[msg];
        let m;
        if ((m = msg.match(/^(.*)'s turn$/i))) return `轮到 ${m[1]}`;
        if ((m = msg.match(/^Game started with (\d+) players$/))) return `游戏开始：${m[1]} 名玩家`;
        if ((m = msg.match(/^took £(\d+) loan$/))) return `贷款 £${m[1]}`;
        let out = msg;
        if ((m = out.match(/^built (.+?) in (.+?)( — .*| \(tile flipped!\))?$/i)) && !/link/.test(out)) out = `在${m[2]}建造了 ${m[1]}${m[3] || ''}`;
        out = out.replace(/\[(.*)\]/, '【$1】').replace(/; /g, '；')
            .replace(/(\S+(?: \d+)?)'s brewery, /gi, '$1 的酿酒厂 · ')
            .replace(/([a-z-]+) merchant beer \(([^)]*)\)/gi, '商人啤酒 · $1（奖励 $2）')
            .replace(/\+(\d+) income spaces/gi, '收入 +$1 格').replace(/\+(\d+) income/gi, '收入 +$1')
            .replace(/\+(\d+) vp/gi, '+$1 分').replace(/free develop earned/gi, '获得免费发展')
            .replace(/free develop:? ?/gi, '免费发展 ').replace(/\bbeer: /gi, '啤酒：')
            .replace(/ \(tile flipped!\)/gi, '（板块已翻面！）')
            .replace(/ — sold (\d+) to market for £(\d+)/gi, '，向市场卖出 $1 个得 £$2')
            .replace(/\(1 beer consumed\)/gi, '（消耗 1 桶啤酒）')
            .replace(/ to cover income shortfall/gi, ' 用于弥补收入不足').replace(/ for £(\d+)/gi, '，得 £$1')
            .replace(/^could not pay income shortfall — lost (\d+) vp/i, '无法支付收入欠款，扣 $1 分');
        for (const [en, zh] of UIManager.LOG_NAMES) {
            out = out.replace(new RegExp(en.replace(/[()]/g, '\\$&'), 'gi'), zh);
        }
        out = out.replace(/ and /gi, ' 和 ').replace(/\(([^()]*)\)/g, '（$1）').replace(/, /g, '，')
            .replace(/\blv(\d)/gi, 'Lv$1').replace(/\blevel (\d)/gi, 'Lv$1')
            .replace(/ +([（【])/g, '$1').replace(/ +([）】])/g, '$1');
        out = out.replace(/^built (canal|rail) link: /i, (_, t) => `建造了${t.toLowerCase() === 'canal' ? '运河' : '铁路'}：`)
            .replace(/^built 2 rail links: /i, '建造了 2 条铁路：')
            .replace(/^developed /i, '发展了 ').replace(/^sold /i, '出售了 ')
            .replace(/^used merchant bonus: developed /i, '使用商人奖励：免费发展 ')
            ;
        return out;
    }
    constructor() {
        this.state = null;
        this.logic = null;
        this.renderer = null;
        this.selectedAction = null;
        this.selectedCard = null;
        this.actionStep = 0; // Multi-step action tracking
        this.pendingData = {}; // Data accumulated during multi-step actions
        this.gameLog = []; // Game log entries
        this.previousPlayerId = null; // Track player changes for transitions
        // Online mode: the server owns the game; this client only renders a
        // redacted copy and sends the chosen action.
        this.online = null;   // OnlineClient instance when playing in a room
        this.mySeat = null;   // seat/player id of this device (-1 = spectator)
        this.waiting = false; // an action was sent and is awaiting the server
        this.pendingBonusInfo = null;
        this.lastEventId = 0;
    }

    // ---- online helpers ----------------------------------------------------
    viewerId() {
        if (this.online) return this.mySeat >= 0 ? this.mySeat : null;
        return this.state.currentPlayerId;
    }

    viewer() {
        const id = this.viewerId();
        return id === null ? null : this.state.players[id];
    }

    canAct() {
        if (!this.state || this.state.gameOver) return false;
        if (this.online) {
            return this.mySeat >= 0 && this.state.currentPlayerId === this.mySeat &&
                !this.state.currentPlayer.isAI && !this.waiting && !this.pendingBonusInfo &&
                this.online.connected;
        }
        return !this.state.currentPlayer.isAI;
    }

    initOnline(gameState, gameLogic, boardRenderer, client) {
        this.online = client;
        this.state = gameState;
        this.logic = gameLogic;
        this.renderer = boardRenderer;
        this.bindEvents();
    }

    // Apply a snapshot pushed by the server (msg = { game, you, log, version, pendingBonus, event })
    applyServerUpdate(gameState, msg) {
        const prevPid = this.state ? this.state.currentPlayerId : null;
        const versionChanged = msg.version !== this.lastVersion;
        this.lastVersion = msg.version;
        this.state = gameState;
        this.logic.state = gameState;
        this.mySeat = msg.you.seat;
        this.waiting = false;
        this.gameLog = msg.log || [];
        this.renderLog();

        if (versionChanged && this.selectedAction) {
            this.selectedAction = null;
            this.actionStep = 0;
            this.pendingData = {};
            this.selectedCard = null;
            this.renderer.clearHighlights();
            this.closeModal();
        }

        const handLabel = document.getElementById('hand-label');
        const matLabel = document.getElementById('mat-label');
        if (handLabel) handLabel.textContent = this.mySeat >= 0 ? '你的手牌' : '观战中';
        if (matLabel) matLabel.textContent = this.mySeat >= 0 ? '你的产业板块' : '';

        this.refresh();
        this.setWaitingOverlay(!this.canAct());

        const cur = this.state.currentPlayer;
        if (!this.state.gameOver && prevPid !== null && cur.id !== prevPid &&
                cur.id === this.mySeat && !cur.isAI) {
            this.showTurnTransition(cur);
        }

        // Gloucester free-develop bonus waiting on this player
        const pb = msg.pendingBonus;
        const mine = pb && pb.count > 0 && Array.isArray(pb.types);
        this.pendingBonusInfo = mine ? pb : null;
        if (mine) {
            this.resolveDevelopBonuses(this.mySeat, 1, () => {});
        }

        // Era scoring / game over events (show each one once per device)
        const ev = msg.event;
        if (ev && ev.id > this.lastEventId) {
            this.lastEventId = ev.id;
            if (this.online.markEventSeen(ev.id)) {
                if (ev.kind === 'scoring') this.showScoring(ev.title, ev.scores);
                else if (ev.kind === 'gameover') this.showGameOver(ev.scores);
            }
        }
    }

    sendOnlineAction(action, pendingData, cardIndex) {
        this.waiting = true;
        this.online.send({ t: 'action', action, pendingData, cardIndex, version: this.lastVersion });
        this.selectedAction = null;
        this.actionStep = 0;
        this.pendingData = {};
        this.selectedCard = null;
        this.renderer.clearHighlights();
        this.updateHand();
        this.updateActionButtons();
        this.updatePhaseBar();
        this.setWaitingOverlay(true);
    }

    setWaitingOverlay(active) {
        document.getElementById('game-screen').classList.toggle('online-waiting', active);
    }

    init(gameState, gameLogic, boardRenderer) {
        this.state = gameState;
        this.logic = gameLogic;
        this.renderer = boardRenderer;

        this.bindEvents();
        this.addLogEntry(null, `游戏开始：${this.state.numPlayers} 名玩家`, 'system');
        this.addLogEntry(null, '运河时代', 'era');
        this.previousPlayerId = this.state.currentPlayerId;
        this.refresh();
        this.runAITurnLoop(); // in case the first seat is AI-controlled
    }

    // ========================================================================
    // Event Binding
    // ========================================================================

    bindEvents() {
        // Action buttons
        document.querySelectorAll('.action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = btn.dataset.action;
                this.onActionSelected(action);
            });
        });

        // Modal close
        document.getElementById('modal-close').addEventListener('click', () => this.closeModal());

        // Board click events (delegated)
        document.getElementById('game-board').addEventListener('click', (e) => {
            this.onBoardClick(e);
        });

        // Phase bar cancel button
        if (typeof ActionIcons !== 'undefined') ActionIcons.mount();

        // Artwork is detected asynchronously; redraw the panels that use it.
        window.addEventListener('boardassets:ready', () => {
            if (!this.state) return;
            this.updateHand();
            this.updatePlayerMat();
            this.updateMarkets();
        });

        document.getElementById('phase-cancel-btn').addEventListener('click', () => {
            this.cancelAction();
        });

        // Escape key to cancel action
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.selectedAction) {
                    this.cancelAction();
                }
            }
        });
    }

    // ========================================================================
    // Refresh UI
    // ========================================================================

    refresh() {
        this.updateTopBar();
        this.updatePlayerPanels();
        this.updateHand();
        this.updateActionButtons();
        this.updatePlayerMat();
        this.updateMarkets();
        this.updatePhaseBar();
        this.renderer.fullUpdate(this.state);
        if (this.online && this.online.onRefresh) this.online.onRefresh();
    }

    updateTopBar() {
        const player = this.state.currentPlayer;
        document.getElementById('era-label').textContent =
            this.state.era === ERA.CANAL ? '运河时代' : '铁路时代';
        document.getElementById('round-label').textContent =
            `第 ${this.state.round} 轮 | 牌堆：${this.state.drawDeck.length}`;

        const playerLabel = document.getElementById('current-player-label');
        playerLabel.textContent = `${player.name} 的回合`;
        playerLabel.style.backgroundColor = player.color;
        playerLabel.style.color = player.colorName === 'White' ? '#1a1510' : 'white';

        const actionsLeft = this.state.actionsPerTurn - this.state.actionsThisTurn;
        document.getElementById('actions-remaining-label').textContent =
            `剩余 ${actionsLeft} 个行动`;

        // Market prices
        const coalPrice = this.state.getCoalPrice();
        const ironPrice = this.state.getIronPrice();
        document.getElementById('coal-price').textContent =
            coalPrice === Infinity ? '售罄' : `£${coalPrice}`;
        document.getElementById('iron-price').textContent =
            ironPrice === Infinity ? '售罄' : `£${ironPrice}`;
    }

    updatePlayerPanels() {
        const container = document.getElementById('player-panels');
        container.innerHTML = '';

        for (const player of this.state.players) {
            const isActive = player.id === this.state.currentPlayerId;
            const panel = document.createElement('div');
            panel.className = `player-panel${isActive ? ' active' : ''}`;
            // Set the left border color via the panel itself (CSS uses border-left)
            panel.style.borderLeftColor = player.color;

            panel.innerHTML = `
                <div class="player-panel-header">
                    <span class="player-panel-name" style="color: ${player.color}">${player.name}${player.isAI ? ' <span class="ai-chip">AI</span>' : ''}</span>
                    <span class="player-panel-vp">${player.vp} <span class="vp-unit" style="font-size:13px;font-weight:400;color:var(--text-muted)">分</span></span>
                </div>
                <div class="player-panel-stats">
                    <span class="player-panel-stat" title="资金" style="color:#c9a84c">£${player.money}</span>
                    <span class="player-panel-stat" title="收入等级">&#8679; ${this.state.getIncomeLevel(player.id)}</span>
                    <span class="player-panel-stat" title="手牌数">${player.hand.length} 张</span>
                    <span class="player-panel-stat" title="剩余连线">
                        ${this.state.era === ERA.CANAL ? player.linksRemaining.canal : player.linksRemaining.rail} 线
                    </span>
                </div>
            `;
            container.appendChild(panel);
        }
    }

    updateHand() {
        const container = document.getElementById('player-hand');
        container.innerHTML = '';

        const player = this.viewer();
        const playerId = this.viewerId();
        if (!player) return; // spectator: no hand to show
        const inCardSelectMode = this.actionStep > 0 && this.selectedAction;

        // Get valid card indices for current action
        let validCardIndices = null;
        if (inCardSelectMode) {
            const target = this.selectedAction === ACTIONS.BUILD ? this.pendingData : null;
            validCardIndices = this.logic.getValidCardsForAction(playerId, this.selectedAction, target);
        }

        const cardArt = typeof BoardAssets !== 'undefined' && BoardAssets.cardsReady();

        player.hand.forEach((card, idx) => {
            const cardEl = document.createElement('div');
            cardEl.className = 'card';
            cardEl.dataset.index = idx;

            // With the printed card faces supplied locally, the card IS the
            // artwork — no drawn type/icon/name layout on top of it.
            const art = cardArt ? BoardAssets.cardUrl(card) : null;
            if (art) {
                cardEl.classList.add('card-art');
                if (card.type === CARD_TYPES.LOCATION) cardEl.classList.add('location-card');
                else if (card.type === CARD_TYPES.INDUSTRY) cardEl.classList.add('industry-card');
                else cardEl.classList.add('wild-card');
                // A two-industry card names both briefly so the label stays on
                // the card's bottom rail instead of spilling over the picture.
                const labelText = (card.type === CARD_TYPES.INDUSTRY && card.industryTypes.length > 1)
                    ? card.industryTypes.map(t => (INDUSTRY_DISPLAY[t] && INDUSTRY_DISPLAY[t].shortName) || t).join('/')
                    : cardDisplayName(card);
                const artLabel = card.type === CARD_TYPES.LOCATION
                    ? ''
                    : `<span class="card-art-label${labelText.length > 3 ? ' long' : ''}" data-full="${cardDisplayName(card)}">${labelText}</span>`;
                cardEl.innerHTML = `<img src="${art}" alt="${card.type === CARD_TYPES.LOCATION ? cardDisplayName(card) : ''}" draggable="false">${artLabel}`;
                if (this.selectedCard === idx) cardEl.classList.add('selected');
                if (this.selectedAction === ACTIONS.SCOUT &&
                        this.pendingData.scoutCards && this.pendingData.scoutCards.includes(idx)) {
                    cardEl.classList.add('scout-queued');
                }
                if (inCardSelectMode && validCardIndices) {
                    cardEl.classList.add(validCardIndices.includes(idx) ? 'valid-discard' : 'invalid-discard');
                }
                cardEl.addEventListener('click', () => this.onCardClicked(idx));
                container.appendChild(cardEl);
                return;
            }

            if (card.type === CARD_TYPES.LOCATION) {
                cardEl.classList.add('location-card');
                const city = CITIES[card.location];
                const regionColor = city ? REGION_COLORS[city.region]?.fill : '#4a4a4a';

                // Apply region color as background tint so cards are visually distinct by
                // region, matching the same region tint used on the board itself.
                if (regionColor) {
                    cardEl.style.borderColor = regionColor;
                    cardEl.style.boxShadow = `0 0 6px ${regionColor}55`;
                    cardEl.style.setProperty('--region-tint', `${regionColor}30`);
                }

                cardEl.innerHTML = `
                    <div class="card-type">地点</div>
                    <div style="font-size:20px;margin:4px 0;">📍</div>
                    <div class="card-name">${cardDisplayName(card)}</div>
                `;
            } else if (card.type === CARD_TYPES.INDUSTRY) {
                cardEl.classList.add('industry-card');
                const isDual = card.industryTypes.length > 1;
                const display = INDUSTRY_DISPLAY[card.industryTypes[0]];
                cardEl.style.setProperty('--industry-ribbon-color', display.color);
                let iconHtml;
                if (isDual) {
                    // Dual "Cotton Mill or Manufacturer" card — show both icons
                    const icons = card.industryTypes
                        .map(t => IndustryIcons.renderMarkup(t, 20, 'full') || INDUSTRY_DISPLAY[t].icon)
                        .join('');
                    iconHtml = `<div style="display:flex;justify-content:center;gap:2px;">${icons}</div>`;
                } else {
                    const svgIcon = IndustryIcons.renderMarkup(card.industryTypes[0], 30, 'full');
                    iconHtml = svgIcon || `<div class="card-icon">${display.icon}</div>`;
                }
                cardEl.innerHTML = `
                    <div class="card-type">产业</div>
                    ${iconHtml}
                    <div class="card-name">${cardDisplayName(card)}</div>
                `;
            } else if (card.type === CARD_TYPES.WILD_LOCATION) {
                cardEl.classList.add('wild-card');
                cardEl.innerHTML = `
                    <div class="card-type">万能</div>
                    <div class="card-icon">&#10038;</div>
                    <div class="card-name">地点</div>
                `;
            } else if (card.type === CARD_TYPES.WILD_INDUSTRY) {
                cardEl.classList.add('wild-card');
                cardEl.innerHTML = `
                    <div class="card-type">万能</div>
                    <div class="card-icon">&#10040;</div>
                    <div class="card-name">产业</div>
                `;
            }

            if (this.selectedCard === idx) {
                cardEl.classList.add('selected');
            }

            // Mark cards already queued for scout discard
            if (this.selectedAction === ACTIONS.SCOUT &&
                    this.pendingData.scoutCards && this.pendingData.scoutCards.includes(idx)) {
                cardEl.classList.add('scout-queued');
            }

            // Card selection mode visual states
            if (inCardSelectMode && validCardIndices) {
                if (validCardIndices.includes(idx)) {
                    cardEl.classList.add('valid-discard');
                } else {
                    cardEl.classList.add('invalid-discard');
                }
            }

            cardEl.addEventListener('click', () => this.onCardClicked(idx));
            container.appendChild(cardEl);
        });

        // Toggle card-select-mode class on bottom panel
        const bottomPanel = document.getElementById('bottom-panel');
        if (inCardSelectMode) {
            bottomPanel.classList.add('card-select-mode');
        } else {
            bottomPanel.classList.remove('card-select-mode');
        }
    }

    updateActionButtons() {
        const playerId = this.state.currentPlayerId;
        const myTurn = this.canAct();

        document.querySelectorAll('.action-btn').forEach(btn => {
            const action = btn.dataset.action;
            if (!myTurn && this.online) {
                btn.disabled = true;
                btn.classList.remove('active');
                btn.title = this.mySeat >= 0 ? '等待其他玩家行动' : '观战中';
                return;
            }
            const canDo = this.logic.canPerformAction(action, playerId);
            btn.disabled = !canDo;
            btn.classList.toggle('active', this.selectedAction === action);

            // Disabled tooltips
            if (!canDo) {
                const reason = this.logic.getDisabledReason(action, playerId);
                btn.title = reason || '当前无法执行该行动';
            } else {
                // Restore default tooltips
                const defaultTitles = {
                    build: '建造一个产业板块',
                    network: '建造运河或铁路',
                    develop: '移除低等级板块',
                    sell: '出售棉花、商品或陶瓷',
                    loan: '贷款 £30',
                    scout: '弃 3 张牌换 2 张万能牌',
                    pass: '跳过（弃一张牌）',
                };
                btn.title = defaultTitles[action] || '';
            }
        });
    }

    updatePlayerMat() {
        const container = document.getElementById('player-mat');
        container.innerHTML = '';

        const matPlayerId = this.viewerId();
        if (matPlayerId === null) return;
        const remaining = this.state.getRemainingTiles(matPlayerId);

        for (const [type, data] of Object.entries(remaining)) {
            const display = INDUSTRY_DISPLAY[type];
            const div = document.createElement('div');
            div.className = 'mat-industry';

            let tilesHtml = '';
            const allTiles = this.state.players[matPlayerId].industryTiles[type];
            const chips = typeof BoardAssets !== 'undefined' && BoardAssets.tilesReady();
            const iconMarkup = chips ? null : IndustryIcons.renderMarkup(type, 12, 'full');
            allTiles.forEach(tile => {
                const cls = tile.used ? 'mat-tile used' : 'mat-tile available';
                // Cost details (money, coal, iron)
                const costParts = [`£${tile.cost}`];
                if (tile.costCoal > 0) costParts.push(`${tile.costCoal} 煤炭`);
                if (tile.costIron > 0) costParts.push(`${tile.costIron} 铁`);
                const costStr = costParts.join(' + ');

                // Era availability
                const eraStr = (tile.canalEra && tile.railEra) ? '运河与铁路时代'
                             : tile.canalEra ? '仅运河时代' : '仅铁路时代';

                // Industry-specific traits
                let extra = '';
                if (tile.beersToSell !== null && tile.beersToSell !== undefined) {
                    extra = ` | 出售需 ${tile.beersToSell} 啤酒`;
                } else if (tile.resourceCubes > 0) {
                    extra = ` | 产出 ${tile.resourceCubes} 个资源`;
                }
                if (!tile.canDevelop) {
                    extra += ' | 不可发展';
                }

                const tooltip = `${display.name} Lv${tile.level}（${tile.used ? '已用' : '可用'}）\n` +
                                `费用：${costStr}\n` +
                                `翻面：${tile.vp} 分，收入 +${tile.income}${extra}\n` +
                                `时代：${eraStr}`;
                if (chips) {
                    // The chip face already carries its level and industry.
                    const art = BoardAssets.tileUrl(type, tile.level, false);
                    tilesHtml += `<div class="${cls} mat-tile-art" data-type="${type}" title="${tooltip}">
                        <img src="${art}" alt="" draggable="false">
                    </div>`;
                } else {
                    tilesHtml += `<div class="${cls}" data-type="${type}" title="${tooltip}">
                        <div class="mat-tile-icon">${iconMarkup}</div>
                        <div class="mat-tile-level">${tile.level}</div>
                    </div>`;
                }
            });

            div.innerHTML = `
                <div class="mat-industry-label">${display.shortName} (${data.count})</div>
                <div class="mat-tiles">${tilesHtml}</div>
            `;
            container.appendChild(div);
        }
    }

    // A wooden cube in projection, matching the ones drawn on board tiles.
    cubeSvg(kind) {
        const tones = {
            coal: ['#4f4f4f', '#2e2e2e', '#1b1b1b'],
            iron: ['#f0983a', '#c06e1c', '#8d4e0e'],
            beer: ['#e8cf6a', '#b99a2c', '#866c16'],
        }[kind] || ['#8a8a8a', '#5f5f5f', '#444'];
        const [top, left, right] = tones;
        // 20x20 box: a squashed top diamond over two side faces.
        return `<svg class="cube-svg" viewBox="0 0 20 20" aria-hidden="true">
            <polygon points="10,2 18,6 10,10 2,6" fill="${top}"/>
            <polygon points="2,6 10,10 10,18 2,14" fill="${left}"/>
            <polygon points="18,6 10,10 10,18 18,14" fill="${right}"/>
        </svg>`;
    }

    updateMarkets() {
        // Coal market
        const coalTrack = document.getElementById('coal-track');
        coalTrack.innerHTML = '';
        const coalPrice = this.state.getCoalPrice();
        document.getElementById('coal-current-price').textContent =
            coalPrice === Infinity ? '售罄' : `价格：£${coalPrice}`;

        for (let i = 0; i < COAL_MARKET_PRICES.length; i++) {
            const filled = i >= (COAL_MARKET_PRICES.length - this.state.coalMarket);
            const space = document.createElement('div');
            space.className = `market-space${filled ? ' filled coal' : ''}`;
            space.title = `£${COAL_MARKET_PRICES[i]}`;
            if (filled) space.innerHTML = this.cubeSvg('coal');
            else space.textContent = COAL_MARKET_PRICES[i];
            coalTrack.appendChild(space);
        }

        // Iron market
        const ironTrack = document.getElementById('iron-track');
        ironTrack.innerHTML = '';
        const ironPrice = this.state.getIronPrice();
        document.getElementById('iron-current-price').textContent =
            ironPrice === Infinity ? '售罄' : `价格：£${ironPrice}`;

        for (let i = 0; i < IRON_MARKET_PRICES.length; i++) {
            const filled = i >= (IRON_MARKET_PRICES.length - this.state.ironMarket);
            const space = document.createElement('div');
            space.className = `market-space${filled ? ' filled iron' : ''}`;
            space.title = `£${IRON_MARKET_PRICES[i]}`;
            if (filled) space.innerHTML = this.cubeSvg('iron');
            else space.textContent = IRON_MARKET_PRICES[i];
            ironTrack.appendChild(space);
        }
    }

    // ========================================================================
    // Phase Bar
    // ========================================================================

    updatePhaseBar() {
        const bar = document.getElementById('action-phase-bar');
        const steps = bar.querySelectorAll('.phase-step');
        const instruction = document.getElementById('phase-instruction');

        if (!this.selectedAction) {
            bar.classList.add('hidden');
            return;
        }

        bar.classList.remove('hidden');

        // Determine which step we're on
        let currentStep = 1; // Choose Action
        let instructionText = '请选择一个行动';

        if (this.selectedAction && this.actionStep === 0) {
            currentStep = 2; // Select Target
            instructionText = this.getTargetInstruction();
        } else if (this.actionStep > 0) {
            currentStep = 3; // Discard Card
            if (this.selectedAction === ACTIONS.SCOUT) {
                const remaining = 3 - (this.pendingData.scoutCards?.length || 0);
                instructionText = `请选择 ${remaining} 张要弃掉的牌`;
            } else {
                instructionText = '点击一张牌弃掉';
            }
        }

        steps.forEach(step => {
            const stepNum = parseInt(step.dataset.step);
            step.classList.remove('active', 'completed');
            if (stepNum < currentStep) {
                step.classList.add('completed');
            } else if (stepNum === currentStep) {
                step.classList.add('active');
            }
        });

        instruction.textContent = instructionText;
    }

    getTargetInstruction() {
        switch (this.selectedAction) {
            case ACTIONS.BUILD: return '从列表中选择要建造的产业';
            case ACTIONS.NETWORK: return '选择要建造的连线';
            case ACTIONS.DEVELOP: return '选择要发展的板块';
            case ACTIONS.SELL: return '选择要出售的产业';
            case ACTIONS.LOAN: return '弃一张牌以贷款 £30';
            case ACTIONS.SCOUT: return '选择 3 张要弃掉的牌';
            case ACTIONS.PASS: return '选择一张要弃掉的牌';
            default: return '';
        }
    }

    // ========================================================================
    // Game Log
    // ========================================================================

    addLogEntry(playerId, message, type = 'action') {
        const entry = {
            playerId,
            message,
            type,
            timestamp: Date.now(),
        };

        this.gameLog.unshift(entry); // Newest first
        if (this.gameLog.length > 100) this.gameLog.pop();
        this.renderLog();
    }

    renderLog() {
        const container = document.getElementById('game-log');
        if (!container) return;

        container.innerHTML = '';

        for (const raw of this.gameLog) {
            const entry = { ...raw, message: UIManager.trLog(raw.message) };
            const div = document.createElement('div');
            div.className = 'log-entry';

            if (entry.type === 'system') {
                div.classList.add('log-system');
                div.textContent = entry.message;
            } else if (entry.type === 'era') {
                div.classList.add('log-era');
                div.textContent = entry.message;
            } else {
                const player = entry.playerId !== null ? this.state.players[entry.playerId] : null;
                if (player) {
                    div.innerHTML = `<span class="log-player" style="color:${player.color}">${player.name}</span> ${entry.message}`;
                } else {
                    div.textContent = entry.message;
                }
            }

            container.appendChild(div);
        }
    }

    // ========================================================================
    // Turn Transition
    // ========================================================================

    showTurnTransition(player) {
        const overlay = document.getElementById('turn-transition');
        const nameEl = document.getElementById('turn-transition-name');
        const subtitleEl = document.querySelector('.turn-transition-subtitle');

        nameEl.textContent = player.name;
        nameEl.style.color = player.color;
        if (subtitleEl) subtitleEl.textContent = this.online ? '轮到你了' : (player.isAI ? 'AI 回合' : '你的回合');

        overlay.classList.remove('hidden', 'fade-out');

        // Auto-dismiss after 1.5s
        setTimeout(() => {
            overlay.classList.add('fade-out');
            setTimeout(() => {
                overlay.classList.add('hidden');
                overlay.classList.remove('fade-out');
            }, 500);
        }, 1000);
    }

    // ========================================================================
    // Card Selection
    // ========================================================================

    onCardClicked(index) {
        if (!this.canAct()) return;
        if (this.selectedCard === index) {
            this.selectedCard = null;
        } else {
            this.selectedCard = index;
        }
        this.updateHand();

        // If we have an action selected and this was a card selection step
        if (this.selectedAction && this.actionStep > 0) {
            this.processActionStep();
        }
    }

    // ========================================================================
    // Action Selection
    // ========================================================================

    onActionSelected(action) {
        if (!this.canAct()) return;
        if (this.selectedAction === action) {
            this.cancelAction();
            return;
        }

        this.selectedAction = action;
        this.actionStep = 0;
        this.pendingData = {};
        this.selectedCard = null;

        this.updateActionButtons();
        this.updatePhaseBar();
        this.startAction(action);
    }

    cancelAction() {
        this.selectedAction = null;
        this.actionStep = 0;
        this.pendingData = {};
        this.selectedCard = null;
        this.renderer.clearHighlights();
        this.updateActionButtons();
        this.updateHand();
        this.updatePhaseBar();
        this.closeModal();
    }

    // ========================================================================
    // Action Execution
    // ========================================================================

    startAction(action) {
        const playerId = this.state.currentPlayerId;

        switch (action) {
            case ACTIONS.BUILD:
                this.startBuild(playerId);
                break;
            case ACTIONS.NETWORK:
                this.startNetwork(playerId);
                break;
            case ACTIONS.DEVELOP:
                this.startDevelop(playerId);
                break;
            case ACTIONS.SELL:
                this.startSell(playerId);
                break;
            case ACTIONS.LOAN:
                this.startLoan(playerId);
                break;
            case ACTIONS.SCOUT:
                this.startScout(playerId);
                break;
            case ACTIONS.PASS:
                this.startPass(playerId);
                break;
        }
    }

    // ========================================================================
    // BUILD
    // ========================================================================

    startBuild(playerId) {
        const targets = this.logic.getValidBuildTargets(playerId);
        if (targets.length === 0) {
            this.showToast('没有可建造的位置', 'warning');
            this.cancelAction();
            return;
        }

        // Store targets for board-click selection
        this.pendingData.buildTargets = targets;

        // Highlight valid slots on the board
        this.renderer.highlightSlots(targets);

        this.showBuildModal(playerId, targets);
    }

    showBuildModal(playerId, targets) {
        const byCity = {};
        for (const t of targets) {
            if (!byCity[t.cityId]) byCity[t.cityId] = [];
            byCity[t.cityId].push(t);
        }

        let html = '<div class="choice-list">';
        for (const [cityId, cityTargets] of Object.entries(byCity)) {
            const cityName = CITIES[cityId]?.name || BREWERY_FARMS[cityId]?.name || cityId;
            for (const target of cityTargets) {
                const display = INDUSTRY_DISPLAY[target.industryType];
                html += `
                    <div class="choice-item" data-city="${target.cityId}"
                         data-slot="${target.slotIndex}" data-type="${target.industryType}">
                        <div class="choice-item-icon">${display.icon}</div>
                        <div class="choice-item-text">
                            <div class="choice-item-name">${display.name} Lv${target.tileData.level}</div>
                            <div class="choice-item-detail">${cityName} （第 ${target.slotIndex + 1} 格）</div>
                        </div>
                        <div class="choice-item-cost">£${target.cost.total}
                            ${target.cost.coal > 0 ? ` + ${target.cost.coal} 煤炭` : ''}
                            ${target.cost.iron > 0 ? ` + ${target.cost.iron} 铁` : ''}
                        </div>
                    </div>
                `;
            }
        }
        html += '</div>';

        this.showModal('建造产业', html, () => {});

        document.querySelectorAll('#modal-body .choice-item').forEach(item => {
            item.addEventListener('click', () => {
                const cityId = item.dataset.city;
                const slotIndex = parseInt(item.dataset.slot);
                const indType = item.dataset.type;
                this.pendingData = { cityId, slotIndex, industryType: indType };
                this.closeModal();
                this.renderer.clearHighlights();
                this.actionStep = 1;
                this.updatePhaseBar();
                this.updateHand();
            });
        });
    }

    // ========================================================================
    // NETWORK
    // ========================================================================

    startNetwork(playerId) {
        const targets = this.logic.getValidNetworkTargets(playerId);
        if (targets.length === 0) {
            this.showToast('没有可建造的连线', 'warning');
            this.cancelAction();
            return;
        }

        this.renderer.highlightConnections(targets.map(t => t.connectionId));

        let html = '<div class="choice-list">';
        for (const target of targets) {
            const city1 = locationName(target.cities[0]);
            const city2 = locationName(target.cities[1]);
            html += `
                <div class="choice-item" data-conn="${target.connectionId}">
                    <div class="choice-item-icon">${target.type === 'canal' ? '~' : '#'}</div>
                    <div class="choice-item-text">
                        <div class="choice-item-name">${city1} — ${city2}</div>
                        <div class="choice-item-detail">${target.type === 'canal' ? '运河' : '铁路'}</div>
                    </div>
                    <div class="choice-item-cost">£${target.cost}</div>
                </div>
            `;
        }
        html += '</div>';

        this.showModal('建网', html, () => {});

        document.querySelectorAll('#modal-body .choice-item').forEach(item => {
            item.addEventListener('click', () => {
                this.afterNetworkFirstSelection(item.dataset.conn);
            });
        });
    }

    // In the Rail Era a second link may be added (£15 total, +1 coal, +1 beer
    // from a brewery). Offer the option after the first link is chosen.
    afterNetworkFirstSelection(connectionId) {
        const playerId = this.state.currentPlayerId;

        if (this.state.era === ERA.RAIL) {
            const seconds = this.logic.getValidSecondRailLinks(playerId, connectionId);
            if (seconds.length > 0) {
                this.showSecondRailModal(connectionId, seconds);
                return;
            }
        }

        this.pendingData = { connectionId };
        this.renderer.clearHighlights();
        this.closeModal();
        this.actionStep = 1;
        this.updatePhaseBar();
        this.updateHand();
    }

    showSecondRailModal(firstConnId, seconds) {
        const name = id => locationName(id);

        let html = '<p style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;">' +
            '可选：再建第二条铁路——两条共 £15，每条另需 1 煤炭，并消耗酿酒厂的 1 桶啤酒。</p>';
        html += '<div class="choice-list">';
        html += '<div class="choice-item" data-conn="none"><div class="choice-item-text"><div class="choice-item-name">只建一条</div><div class="choice-item-detail">£5 + 1 煤炭</div></div></div>';
        for (const s of seconds) {
            html += `
                <div class="choice-item" data-conn="${s.connectionId}">
                    <div class="choice-item-icon">#</div>
                    <div class="choice-item-text">
                        <div class="choice-item-name">${name(s.cities[0])} — ${name(s.cities[1])}</div>
                        <div class="choice-item-detail">第二条 · +1 啤酒</div>
                    </div>
                    <div class="choice-item-cost">共 £15${s.coalCost > 0 ? ` + £${s.coalCost} 煤炭` : ''}</div>
                </div>
            `;
        }
        html += '</div>';

        this.showModal('建第二条铁路？', html, () => {});

        document.querySelectorAll('#modal-body .choice-item').forEach(item => {
            item.addEventListener('click', () => {
                const conn2 = item.dataset.conn;
                this.pendingData = { connectionId: firstConnId };
                if (conn2 !== 'none') this.pendingData.connectionId2 = conn2;
                this.renderer.clearHighlights();
                this.closeModal();
                this.actionStep = 1;
                this.updatePhaseBar();
                this.updateHand();
            });
        });
    }

    // ========================================================================
    // DEVELOP
    // ========================================================================

    startDevelop(playerId) {
        const types = this.logic.getDevelopableTypes(playerId);
        if (types.length === 0) {
            this.showToast('没有可发展的板块', 'warning');
            this.cancelAction();
            return;
        }

        let html = '<p style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;">从玩家板上移除 1–2 个板块以解锁更高等级，每个板块消耗 1 铁。</p>';
        html += '<div class="choice-list">';
        for (const t of types) {
            const display = INDUSTRY_DISPLAY[t.type];
            html += `
                <div class="choice-item" data-type="${t.type}">
                    <div class="choice-item-icon">${display.icon}</div>
                    <div class="choice-item-text">
                        <div class="choice-item-name">${display.name} Lv${t.level}</div>
                        <div class="choice-item-detail">移除此板块</div>
                    </div>
                </div>
            `;
        }
        html += '</div>';

        this.showModal('发展（选择第 1 个板块）', html, () => {});

        document.querySelectorAll('#modal-body .choice-item').forEach(item => {
            item.addEventListener('click', () => {
                const type1 = item.dataset.type;
                this.pendingData.industryType1 = type1;
                this.showDevelopSecondChoice(playerId, type1);
            });
        });
    }

    showDevelopSecondChoice(playerId, firstType) {
        const types = this.logic.getDevelopableTypes(playerId);
        const remainingTypes = types.filter(t => {
            if (t.type === firstType) {
                const remaining = this.state.getRemainingTiles(playerId);
                return remaining[t.type].count > 1;
            }
            return true;
        });

        const ironSources = this.state.findIronSource(playerId);
        const canAffordTwo = ironSources.length >= 2;

        if (!canAffordTwo || remainingTypes.length === 0) {
            this.closeModal();
            this.actionStep = 1;
            this.updatePhaseBar();
            this.updateHand();
            return;
        }

        let html = '<p style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;">可选：再发展第二个板块（再消耗 1 铁）。</p>';
        html += '<div class="choice-list">';
        html += '<div class="choice-item" data-type="none"><div class="choice-item-text"><div class="choice-item-name">完成（只发展 1 个）</div></div></div>';

        for (const t of remainingTypes) {
            const display = INDUSTRY_DISPLAY[t.type];
            html += `
                <div class="choice-item" data-type="${t.type}">
                    <div class="choice-item-icon">${display.icon}</div>
                    <div class="choice-item-text">
                        <div class="choice-item-name">${display.name} Lv${t.level}</div>
                    </div>
                </div>
            `;
        }
        html += '</div>';

        this.showModal('发展（可选第 2 个板块）', html, () => {});

        document.querySelectorAll('#modal-body .choice-item').forEach(item => {
            item.addEventListener('click', () => {
                const type2 = item.dataset.type;
                this.pendingData.industryType2 = type2 === 'none' ? null : type2;
                this.closeModal();
                this.actionStep = 1;
                this.updatePhaseBar();
                this.updateHand();
            });
        });
    }

    // ========================================================================
    // SELL
    // ========================================================================

    startSell(playerId) {
        const targets = this.logic.getValidSellTargets(playerId);
        if (targets.length === 0) {
            this.showToast('没有可出售的产业', 'warning');
            this.cancelAction();
            return;
        }
        const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const byKey = {};
        targets.forEach(t => { byKey[t.key] = t; t.sources = this.logic.getSellBeerSources(playerId, t.key); });

        let html = '<p style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;">点选要出售的产业（可一次卖多个），再为每个产业选择用哪桶啤酒：自己的酿酒厂（不需相连）、相连的对手酿酒厂（用完会让对方翻面加收入），或所卖商人的啤酒（得到该商人的奖励）。</p>';
        html += '<div class="choice-list">';
        for (const target of targets) {
            const display = INDUSTRY_DISPLAY[target.tile.type];
            const cityName = CITIES[target.cityId]?.name || target.cityId;
            html += `
                <div class="choice-item sell-item" data-key="${target.key}" data-selected="false">
                    <div class="choice-item-icon">${display.icon}</div>
                    <div class="choice-item-text">
                        <div class="choice-item-name">${display.name} Lv${target.tile.tileData.level}</div>
                        <div class="choice-item-detail">${cityName} | 分数：${target.tile.tileData.vp} | 收入：+${target.tile.tileData.income}
                        ${target.beerNeeded > 0 ? ` | 需啤酒：${target.beerNeeded}` : ' | 不需要啤酒'}</div>
                        <div class="sell-beer" data-key="${target.key}"></div>
                    </div>
                </div>
            `;
        }
        html += '</div>';

        const footer = '<div id="sell-status" class="sell-status"></div><button class="modal-btn modal-btn-primary" id="confirm-sell">出售所选</button>';
        this.showModal('销售', html, null, footer);

        const selected = [];   // keys, in the order they will be sold
        const choice = {};     // key -> [sourceId | '']
        const complete = k => (choice[k] || []).every(id => id);
        const planFor = (auto) => selected.map(k => (complete(k) && k !== auto)
            ? { key: k, beer: choice[k].slice() }
            : { key: k, useMerchantBeer: true });
        const statusEl = document.getElementById('sell-status');
        const confirmBtn = document.getElementById('confirm-sell');

        const validate = () => {
            let msg = '', ok = false;
            if (selected.length === 0) msg = '请至少选择一个产业';
            else if (!selected.every(complete)) msg = '请为每个产业选好啤酒';
            else {
                const r = this.logic.resolveSellPlan(playerId, selected.map(k => ({ key: k, beer: choice[k].slice() })));
                ok = r.ok;
                msg = ok ? `可以出售 ${selected.length} 个产业` : r.zh;
            }
            statusEl.textContent = msg;
            statusEl.classList.toggle('ok', ok);
            confirmBtn.disabled = !ok;
            return ok;
        };

        const render = () => {
            // barrels used by every select, to show what is left on each source
            const used = {};
            for (const k of selected) for (const id of choice[k] || []) if (id) used[id] = (used[id] || 0) + 1;
            document.querySelectorAll('#modal-body .sell-item').forEach(item => {
                const k = item.dataset.key;
                const on = selected.includes(k);
                item.dataset.selected = on ? 'true' : 'false';
                item.style.borderColor = on ? 'var(--accent-gold)' : '';
                const box = item.querySelector('.sell-beer');
                const t = byKey[k];
                if (!on || t.beerNeeded === 0) { box.innerHTML = ''; return; }
                let h = '';
                (choice[k] || []).forEach((cur, u) => {
                    h += `<label class="sell-beer-row">第 ${u + 1} 桶 <select data-key="${k}" data-unit="${u}"><option value="">— 选择啤酒 —</option>`;
                    for (const src of t.sources) {
                        const left = src.count - (used[src.id] || 0) + (cur === src.id ? 1 : 0);
                        const dis = left <= 0 && cur !== src.id ? ' disabled' : '';
                        h += `<option value="${src.id}"${cur === src.id ? ' selected' : ''}${dis}>${esc(src.labelZh)}（剩 ${Math.max(0, left - (cur === src.id ? 1 : 0))} 桶）</option>`;
                    }
                    h += '</select></label>';
                });
                box.innerHTML = h;
            });
            document.querySelectorAll('#modal-body .sell-beer select').forEach(sel => {
                sel.addEventListener('click', e => e.stopPropagation());
                sel.addEventListener('change', () => {
                    choice[sel.dataset.key][+sel.dataset.unit] = sel.value;
                    render();
                });
            });
            validate();
        };

        document.querySelectorAll('#modal-body .sell-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.sell-beer')) return; // beer picker, not row select
                const key = item.dataset.key;
                const idx = selected.indexOf(key);
                if (idx >= 0) {
                    selected.splice(idx, 1);
                    delete choice[key];
                } else {
                    selected.push(key);
                    const need = byKey[key].beerNeeded;
                    choice[key] = Array(need).fill('');
                    // Sensible default: the engine's pick (merchant beer first for
                    // the free bonus, then own breweries, then opponents') from
                    // what the other selected sales leave
                    const r = this.logic.resolveSellPlan(playerId, planFor(key));
                    if (r.ok) for (const st of r.steps) if (!complete(st.key) || st.key === key) choice[st.key] = st.beer.slice();
                }
                render();
            });
        });

        confirmBtn.addEventListener('click', () => {
            if (selected.length === 0) {
                this.showToast('请至少选择一个要出售的产业', 'warning');
                return;
            }
            if (!validate()) {
                this.showToast(statusEl.textContent, 'warning');
                return;
            }
            this.pendingData.sellPlan = selected.map(k => ({ key: k, beer: choice[k].slice() }));
            this.closeModal();
            this.actionStep = 1;
            this.updatePhaseBar();
            this.updateHand();
        });
        render();
    }

    // ========================================================================
    // LOAN
    // ========================================================================

    startLoan(playerId) {
        this.actionStep = 1;
        this.updatePhaseBar();
        this.updateHand();
    }

    // ========================================================================
    // SCOUT
    // ========================================================================

    startScout(playerId) {
        this.pendingData.scoutCards = [];
        this.actionStep = 1;
        this.updatePhaseBar();
        this.updateHand();
    }

    // ========================================================================
    // PASS
    // ========================================================================

    startPass(playerId) {
        this.actionStep = 1;
        this.updatePhaseBar();
        this.updateHand();
    }

    // ========================================================================
    // Process multi-step action
    // ========================================================================

    processActionStep() {
        if (this.selectedCard === null) return;

        const playerId = this.state.currentPlayerId;
        const cardIndex = this.selectedCard;

        if (this.online) {
            const a = this.selectedAction;
            const pd = this.pendingData || {};
            if (a === ACTIONS.SCOUT) {
                if (!pd.scoutCards) pd.scoutCards = [];
                if (pd.scoutCards.includes(cardIndex)) {
                    this.selectedCard = null;
                    this.updateHand();
                    return;
                }
                pd.scoutCards.push(cardIndex);
                if (pd.scoutCards.length < 3) {
                    this.selectedCard = null;
                    this.updatePhaseBar();
                    this.updateHand();
                    return;
                }
                this.sendOnlineAction(a, { scoutCards: pd.scoutCards.slice() }, null);
                return;
            }
            let data = {};
            if (a === ACTIONS.BUILD) data = { cityId: pd.cityId, slotIndex: pd.slotIndex, industryType: pd.industryType };
            else if (a === ACTIONS.NETWORK) data = { connectionId: pd.connectionId, connectionId2: pd.connectionId2 || null };
            else if (a === ACTIONS.DEVELOP) data = { industryType1: pd.industryType1, industryType2: pd.industryType2 || null };
            else if (a === ACTIONS.SELL) data = { sellPlan: pd.sellPlan || [] };
            this.sendOnlineAction(a, data, cardIndex);
            return;
        }

        switch (this.selectedAction) {
            case ACTIONS.BUILD: {
                const result = this.logic.executeBuild(
                    playerId,
                    this.pendingData.cityId,
                    this.pendingData.slotIndex,
                    this.pendingData.industryType,
                    cardIndex
                );
                if (result.success) {
                    const display = INDUSTRY_DISPLAY[this.pendingData.industryType];
                    const cityName = CITIES[this.pendingData.cityId]?.name ||
                        BREWERY_FARMS[this.pendingData.cityId]?.name || this.pendingData.cityId;
                    this.addLogEntry(playerId, `在${cityName}建造了 ${display.name}`);
                }
                this.completeAction(result);
                break;
            }

            case ACTIONS.NETWORK: {
                const result = this.pendingData.connectionId2
                    ? this.logic.executeNetworkDouble(
                        playerId,
                        this.pendingData.connectionId,
                        this.pendingData.connectionId2,
                        cardIndex)
                    : this.logic.executeNetwork(
                        playerId,
                        this.pendingData.connectionId,
                        cardIndex);
                if (result.success) {
                    this.addLogEntry(playerId, result.message);
                }
                this.completeAction(result);
                break;
            }

            case ACTIONS.DEVELOP: {
                const result = this.logic.executeDevelop(
                    playerId,
                    this.pendingData.industryType1,
                    this.pendingData.industryType2,
                    cardIndex
                );
                if (result.success) {
                    this.addLogEntry(playerId, result.message);
                }
                this.completeAction(result);
                break;
            }

            case ACTIONS.SELL: {
                const result = this.logic.executeSell(
                    playerId,
                    this.pendingData.sellPlan,
                    cardIndex,
                    { autoResolveDevelop: this.state.players[playerId].isAI }
                );
                if (result.success) {
                    this.addLogEntry(playerId, result.message);
                    if (result.pendingDevelopBonuses > 0) {
                        // Gloucester bonus: let the human choose which tile(s)
                        // to remove before the turn advances
                        this.resolveDevelopBonuses(playerId, result.pendingDevelopBonuses,
                            () => this.completeAction(result));
                        break;
                    }
                }
                this.completeAction(result);
                break;
            }

            case ACTIONS.LOAN: {
                const result = this.logic.executeLoan(playerId, cardIndex);
                if (result.success) {
                    this.addLogEntry(playerId, `贷款 £${LOAN_AMOUNT}`);
                }
                this.completeAction(result);
                break;
            }

            case ACTIONS.SCOUT: {
                if (!this.pendingData.scoutCards) this.pendingData.scoutCards = [];
                // Prevent selecting the same card index twice
                if (this.pendingData.scoutCards.includes(cardIndex)) {
                    this.selectedCard = null;
                    this.updateHand();
                    break;
                }
                this.pendingData.scoutCards.push(cardIndex);

                if (this.pendingData.scoutCards.length >= 3) {
                    const result = this.logic.executeScout(playerId, this.pendingData.scoutCards);
                    if (result.success) {
                        this.addLogEntry(playerId, '侦察（获得万能牌）');
                    }
                    this.completeAction(result);
                } else {
                    this.selectedCard = null;
                    this.updatePhaseBar();
                    this.updateHand();
                }
                break;
            }

            case ACTIONS.PASS: {
                const result = this.logic.executePass(playerId, cardIndex);
                if (result.success) {
                    this.addLogEntry(playerId, '跳过');
                }
                this.completeAction(result);
                break;
            }
        }
    }

    // Gloucester merchant bonus: modal chain letting a human pick which
    // tile(s) to remove from their mat (or skip), then continue the turn.
    resolveDevelopBonuses(playerId, count, done) {
        let types = this.logic.getDevelopableTypes(playerId);
        if (this.online && this.pendingBonusInfo) {
            const allowed = this.pendingBonusInfo.types;
            types = types.filter(t => allowed.includes(t.type));
            if (types.length === 0) { this.online.send({ t: 'bonus', type: 'skip' }); return; }
        }
        if (count <= 0 || types.length === 0) {
            this.closeModal();
            done();
            return;
        }

        let html = '<p style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;">商人奖励：免费从玩家板上移除一个板块（不消耗铁），或放弃。</p>';
        html += '<div class="choice-list">';
        html += '<div class="choice-item" data-type="skip"><div class="choice-item-text"><div class="choice-item-name">放弃奖励</div></div></div>';
        for (const t of types) {
            const display = INDUSTRY_DISPLAY[t.type];
            html += `
                <div class="choice-item" data-type="${t.type}">
                    <div class="choice-item-icon">${display.icon}</div>
                    <div class="choice-item-text">
                        <div class="choice-item-name">${display.name} Lv${t.level}</div>
                    </div>
                </div>
            `;
        }
        html += '</div>';

        this.showModal('免费发展（商人奖励）', html, () => {});

        document.querySelectorAll('#modal-body .choice-item').forEach(item => {
            item.addEventListener('click', () => {
                const type = item.dataset.type;
                if (this.online) {
                    this.closeModal();
                    this.pendingBonusInfo = null;
                    this.waiting = true;
                    this.online.send({ t: 'bonus', type });
                    return;
                }
                if (type === 'skip') {
                    this.closeModal();
                    done();
                    return;
                }
                const removed = this.logic.applyFreeDevelop(playerId, 1, type);
                if (removed.length) {
                    this.addLogEntry(playerId, `使用商人奖励：免费发展 ${removed[0]}`);
                }
                this.resolveDevelopBonuses(playerId, count - 1, done);
            });
        });
    }

    completeAction(result) {
        if (result.success) {
            this.showToast(result.message, 'success');
        } else {
            this.showToast(result.message, 'error');
            this.cancelAction();
            return;
        }

        const previousPlayerId = this.state.currentPlayerId;

        // Reset action state
        this.selectedAction = null;
        this.actionStep = 0;
        this.pendingData = {};
        this.selectedCard = null;
        this.renderer.clearHighlights();

        const turnResult = this.state.advanceTurn();

        // Surface end-of-round upkeep events (income shortfall sales etc.)
        for (const ev of this.state.lastRoundEvents || []) {
            this.addLogEntry(ev.playerId, ev.message);
        }
        this.state.lastRoundEvents = [];

        if (turnResult === 'endCanalEra') {
            this.addLogEntry(null, '运河时代计分', 'era');
            const scores = this.state.endCanalEra();
            this.addLogEntry(null, '铁路时代', 'era');
            this.refresh();
            this.showScoring('运河时代结束', scores);
            // runAITurnLoop() resumes from the scoring modal's Continue button
            // (see showScoring) — never auto-continue while it's blocking the screen.
            return;
        } else if (turnResult === 'endGame') {
            this.addLogEntry(null, '最终计分', 'era');
            const scores = this.state.endGame();
            this.refresh();
            this.showGameOver(scores);
            return;
        } else {
            // Check if player changed - show transition
            const newPlayerId = this.state.currentPlayerId;
            if (newPlayerId !== previousPlayerId) {
                this.addLogEntry(null, `轮到 ${this.state.currentPlayer.name}`, 'system');
                this.showTurnTransition(this.state.currentPlayer);
            }
        }

        this.previousPlayerId = previousPlayerId;
        this.refresh();
        this.runAITurnLoop();
    }

    // ========================================================================
    // AI Turn Loop
    // ========================================================================

    runAITurnLoop() {
        if (this.online) return; // the server runs AI seats
        if (this.state.gameOver) return;
        const player = this.state.currentPlayer;
        if (!player.isAI) {
            this.setAIOverlay(false);
            return;
        }
        this.setAIOverlay(true);
        const delay = this.state.currentPlayerId !== this.previousPlayerId ? 1600 : 800;
        setTimeout(() => this.executeOneAITurn(), delay);
    }

    executeOneAITurn() {
        if (this.state.gameOver) return;
        const playerId = this.state.currentPlayerId;
        const player = this.state.players[playerId];
        if (!player.isAI) return; // safety guard against stale timers

        const decision = AIPlayer.chooseAction(this.state, this.logic, playerId, player.aiDifficulty);

        this.selectedAction = decision.action;
        this.pendingData = decision.pendingData;
        this.selectedCard = decision.cardIndex;
        this.processActionStep();
    }

    setAIOverlay(active) {
        document.getElementById('game-screen').classList.toggle('ai-turn-active', active);
    }

    // ========================================================================
    // Board Click Handler
    // ========================================================================

    onBoardClick(e) {
        if (!this.canAct()) return;
        const target = e.target.closest('.industry-slot, .connection-line, .brewery-farm, .merchant-group');
        if (!target) return;

        if (this.selectedAction === ACTIONS.BUILD && this.actionStep === 0) {
            // Farm brewery clicks
            const farm = target.closest('.brewery-farm');
            if (farm && farm.classList.contains('highlight-slot')) {
                const farmId = farm.dataset.farm;
                const farmTargets = (this.pendingData.buildTargets || []).filter(t => t.cityId === farmId);
                if (farmTargets.length >= 1) {
                    this.pendingData = { cityId: farmId, slotIndex: 0, industryType: INDUSTRY_TYPES.BREWERY };
                    this.closeModal();
                    this.renderer.clearHighlights();
                    this.actionStep = 1;
                    this.updatePhaseBar();
                    this.updateHand();
                    return;
                }
            }

            const slot = target.closest('.industry-slot');
            if (slot && slot.classList.contains('highlight-slot')) {
                const cityId = slot.dataset.city;
                const slotIndex = parseInt(slot.dataset.slot);
                const targets = (this.pendingData.buildTargets || []).filter(
                    t => t.cityId === cityId && t.slotIndex === slotIndex
                );
                if (targets.length === 1) {
                    // Single option for this slot — select it directly
                    this.pendingData = { cityId, slotIndex, industryType: targets[0].industryType };
                    this.closeModal();
                    this.renderer.clearHighlights();
                    this.actionStep = 1;
                    this.updatePhaseBar();
                    this.updateHand();
                } else if (targets.length > 1) {
                    // Multiple types for this slot — show filtered modal
                    this.closeModal();
                    this.showBuildModal(this.state.currentPlayerId, targets);
                }
            }
        }

        if (this.selectedAction === ACTIONS.NETWORK) {
            const line = target.closest('.connection-line');
            if (line && line.classList.contains('highlight')) {
                this.afterNetworkFirstSelection(line.dataset.connection);
            }
        }
    }

    // ========================================================================
    // Modal
    // ========================================================================

    showModal(title, bodyHtml, onClose, footerHtml = '') {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = bodyHtml;
        document.getElementById('modal-footer').innerHTML = footerHtml;
        document.getElementById('modal-overlay').classList.remove('hidden');
    }

    closeModal() {
        document.getElementById('modal-overlay').classList.add('hidden');
    }

    // ========================================================================
    // Toast
    // ========================================================================

    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100px)';
            toast.style.transition = 'all 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ========================================================================
    // Scoring Display
    // ========================================================================

    showScoring(title, scores) {
        const overlay = document.getElementById('scoring-overlay');
        document.getElementById('scoring-title').textContent = UIManager.trLog(title);

        let html = '<table class="scoring-table"><thead><tr><th>玩家</th><th>连线分</th><th>产业分</th><th>总分</th></tr></thead><tbody>';
        for (const s of scores) {
            const player = this.state.players[s.playerId];
            html += `<tr>
                <td style="color:${player.color}">${player.name}</td>
                <td>${s.linkVP}</td>
                <td>${s.industryVP}</td>
                <td class="total-row">${s.totalVP}</td>
            </tr>`;
        }
        html += '</tbody></table>';

        document.getElementById('scoring-details').innerHTML = html;
        overlay.classList.remove('hidden');

        const continueFromScoring = () => {
            overlay.classList.add('hidden');
            this.refresh();
            this.runAITurnLoop(); // only safe to resume AFTER the modal is dismissed
        };
        document.getElementById('scoring-continue-btn').onclick = continueFromScoring;

        // In an all-AI (spectator) game there's no human to click Continue —
        // auto-dismiss after a brief pause so the game keeps progressing.
        if (this.state.players.every(p => p.isAI)) {
            setTimeout(continueFromScoring, 2500);
        }
    }

    showGameOver(scores) {
        const overlay = document.getElementById('gameover-overlay');

        // Rulebook: ties broken by highest income level, then most money
        const sorted = [...this.state.players].sort((a, b) =>
            (b.vp - a.vp) ||
            (this.state.getIncomeLevel(b.id) - this.state.getIncomeLevel(a.id)) ||
            (b.money - a.money));

        let html = '<table class="scoring-table"><thead><tr><th>名次</th><th>玩家</th><th>分数</th><th>收入</th><th>资金</th></tr></thead><tbody>';
        sorted.forEach((p, i) => {
            html += `<tr${i === 0 ? ' class="total-row"' : ''}>
                <td>${i + 1}</td>
                <td style="color:${p.color}">${p.name}</td>
                <td>${p.vp}</td>
                <td>${this.state.getIncomeLevel(p.id)}</td>
                <td>£${p.money}</td>
            </tr>`;
        });
        html += '</tbody></table>';

        document.getElementById('final-scores').innerHTML = html;
        overlay.classList.remove('hidden');

        const newGameBtn = document.getElementById('new-game-btn');
        newGameBtn.textContent = this.online ? (this.online.isHost ? '回到房间再来一局' : '关闭') : '新游戏';
        newGameBtn.onclick = () => {
            overlay.classList.add('hidden');
            if (this.online) {
                if (this.online.isHost) this.online.send({ t: 'restart' });
                return;
            }
            document.getElementById('game-screen').classList.remove('active');
            document.getElementById('setup-screen').classList.add('active');
        };
    }
}

UIManager.LOG_NAMES = [
        ["Burton-on-Trent", "伯顿"],
        ["Stoke-on-Trent", "斯托克"],
        ["Wolverhampton", "伍尔弗汉普顿"],
        ["Coalbrookdale", "科尔布鲁克代尔"],
        ["Kidderminster", "基德明斯特"],
        ["Manufacturer", "制造厂"],
        ["Cotton Mill", "棉纺厂"],
        ["Brewery (N)", "酿酒厂（北）"],
        ["Brewery (S)", "酿酒厂（南）"],
        ["Birmingham", "伯明翰"],
        ["Shrewsbury", "什鲁斯伯里"],
        ["Gloucester", "格洛斯特"],
        ["Warrington", "沃灵顿"],
        ["Nottingham", "诺丁汉"],
        ["Iron Works", "铁厂"],
        ["Uttoxeter", "阿托克西特"],
        ["Worcester", "伍斯特"],
        ["Coal Mine", "煤矿"],
        ["Stafford", "斯塔福德"],
        ["Tamworth", "塔姆沃思"],
        ["Coventry", "考文垂"],
        ["Nuneaton", "纳尼顿"],
        ["Redditch", "雷迪奇"],
        ["Cannock", "坎诺克"],
        ["Walsall", "沃尔索尔"],
        ["Pottery", "陶瓷厂"],
        ["Brewery", "酿酒厂"],
        ["Belper", "贝尔珀"],
        ["Dudley", "达德利"],
        ["Oxford", "牛津"],
        ["Derby", "德比"],
        ["Stone", "斯通"],
        ["Leek", "利克"]
];
