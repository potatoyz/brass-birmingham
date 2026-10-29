// ============================================================================
// Brass: Birmingham - Game Logic
// ============================================================================

class GameLogic {
    constructor(gameState) {
        this.state = gameState;
    }

    // ========================================================================
    // Action Validation
    // ========================================================================

    canPerformAction(action, playerId) {
        const player = this.state.players[playerId];
        if (player.hand.length === 0) return false;

        switch (action) {
            case ACTIONS.BUILD: return this.getValidBuildTargets(playerId).length > 0;
            case ACTIONS.NETWORK: return this.getValidNetworkTargets(playerId).length > 0;
            case ACTIONS.DEVELOP: return this.canDevelop(playerId);
            case ACTIONS.SELL: return this.getValidSellTargets(playerId).length > 0;
            case ACTIONS.LOAN: return this.state.canTakeLoan(playerId);
            case ACTIONS.SCOUT: return this.canScout(playerId);
            case ACTIONS.PASS: return true; // Can always pass
            default: return false;
        }
    }

    // ========================================================================
    // BUILD Action
    // ========================================================================

    getValidBuildTargets(playerId) {
        const targets = [];

        for (const [cityId, city] of Object.entries(CITIES)) {
            // Rulebook slot preference: a tile must go on a vacant space
            // showing ONLY its icon if one exists; multi-icon spaces are only
            // legal once no vacant single-icon space matches. (Overbuilding
            // occupied slots is exempt.)
            const vacantSingleIconTypes = new Set();
            city.slots.forEach((slotTypes, slotIndex) => {
                const key = `${cityId}_${slotIndex}`;
                const allowed = Array.isArray(slotTypes) ? slotTypes : [slotTypes];
                if (!this.state.boardIndustries[key] && allowed.length === 1) {
                    vacantSingleIconTypes.add(allowed[0]);
                }
            });

            city.slots.forEach((slotTypes, slotIndex) => {
                const key = `${cityId}_${slotIndex}`;
                const existing = this.state.boardIndustries[key];

                // Check each industry type allowed in this slot
                const allowedTypes = Array.isArray(slotTypes) ? slotTypes : [slotTypes];

                for (const indType of allowedTypes) {
                    // Slot preference: skip multi-icon vacant slots when a
                    // vacant single-icon slot exists for this industry
                    if (!existing && allowedTypes.length > 1 && vacantSingleIconTypes.has(indType)) {
                        continue;
                    }

                    const target = this.checkBuildTarget(playerId, cityId, slotIndex, indType, existing);
                    if (target) targets.push(target);
                }
            });
        }

        // Farm Breweries: standalone locations with a single brewery space,
        // buildable only via a Brewery Industry card or Wild Industry card
        for (const farmId of Object.keys(BREWERY_FARMS)) {
            const existing = this.state.breweryFarmTiles[farmId];
            const target = this.checkBuildTarget(playerId, farmId, 0, INDUSTRY_TYPES.BREWERY, existing);
            if (target) targets.push(target);
        }

        return targets;
    }

    // Shared validation for one (location, slot, industry) build candidate.
    // Returns a target object or null.
    checkBuildTarget(playerId, cityId, slotIndex, indType, existing) {
        const nextTile = this.state.getNextTile(playerId, indType);
        if (!nextTile) return null;

        // Era restrictions
        if (this.state.era === ERA.CANAL && !nextTile.canalEra) return null;
        if (this.state.era === ERA.RAIL && !nextTile.railEra) return null;

        // Canal era: only one tile per location per player.
        // Exclude the current slot from the check: overbuilding it
        // would replace the existing tile, keeping the count at 1.
        if (this.state.era === ERA.CANAL && isCity(cityId)) {
            const city = CITIES[cityId];
            for (let i = 0; i < city.slots.length; i++) {
                if (i === slotIndex) continue;
                const t = this.state.boardIndustries[`${cityId}_${i}`];
                if (t && t.playerId === playerId) return null;
            }
        }

        // Overbuilding: always requires a higher-level tile of the SAME industry
        if (existing) {
            if (existing.type !== indType) return null;
            if (nextTile.level <= existing.tileData.level) return null;
            if (existing.playerId !== playerId) {
                // Opponent tiles: only Coal Mines / Iron Works, and only when
                // no cubes of that resource exist anywhere (board + market)
                if (existing.type !== INDUSTRY_TYPES.COAL_MINE &&
                    existing.type !== INDUSTRY_TYPES.IRON_WORKS) return null;
                if (!this.isResourceDepleted(existing.type)) return null;
            }
        }

        const cost = this.calculateBuildCost(playerId, indType, cityId);
        if (cost === null) return null;

        if (!this.hasCardForBuild(playerId, cityId, indType)) return null;

        return {
            cityId,
            slotIndex,
            industryType: indType,
            tileData: nextTile,
            cost,
        };
    }

    // Does the player have no presence on the board at all? (Enables the
    // "build anywhere with an Industry card" exception.)
    playerHasNoTilesOnBoard(playerId) {
        const hasIndustry = Object.values(this.state.boardIndustries).some(t => t.playerId === playerId) ||
            Object.values(this.state.breweryFarmTiles).some(t => t && t.playerId === playerId);
        if (hasIndustry) return false;
        const hasLink = Object.values(this.state.boardLinks).some(l => l.playerId === playerId);
        return !hasLink;
    }

    hasCardForBuild(playerId, cityId, industryType) {
        const player = this.state.players[playerId];
        const isFarm = isBreweryFarm(cityId);
        const inNetwork = this.state.isInNetwork(playerId, cityId);
        // Industry cards normally require the location to be in your network,
        // but a player with nothing on the board may build anywhere with one
        const industryCardOk = inNetwork || this.playerHasNoTilesOnBoard(playerId);

        for (const card of player.hand) {
            if (card.type === CARD_TYPES.LOCATION) {
                // Location card: build at that location (no network needed).
                // No location cards exist for the farm breweries.
                if (!isFarm && card.location === cityId) return true;
            } else if (card.type === CARD_TYPES.INDUSTRY) {
                if (card.industryTypes.includes(industryType) && industryCardOk) return true;
            } else if (card.type === CARD_TYPES.WILD_LOCATION) {
                // Wild location: any location EXCEPT the farm breweries
                if (!isFarm) return true;
            } else if (card.type === CARD_TYPES.WILD_INDUSTRY) {
                if (industryCardOk) return true;
            }
        }
        return false;
    }

    calculateBuildCost(playerId, industryType, cityId) {
        const player = this.state.players[playerId];
        const tile = this.state.getNextTile(playerId, industryType);
        if (!tile) return null;

        let moneyCost = tile.cost;
        let coalNeeded = tile.costCoal;
        let ironNeeded = tile.costIron;

        // Find cheapest coal sources
        let coalCost = 0;
        if (coalNeeded > 0) {
            const sources = this.state.findCoalSource(cityId, playerId);
            let remaining = coalNeeded;
            for (const src of sources) {
                if (remaining <= 0) break;
                if (src.free) {
                    remaining--;
                } else {
                    coalCost += src.price;
                    remaining--;
                }
            }
            if (remaining > 0) return null; // Not enough coal
        }

        // Find cheapest iron sources
        let ironCost = 0;
        if (ironNeeded > 0) {
            const sources = this.state.findIronSource(playerId);
            let remaining = ironNeeded;
            for (const src of sources) {
                if (remaining <= 0) break;
                if (src.free) {
                    remaining--;
                } else {
                    ironCost += src.price;
                    remaining--;
                }
            }
            if (remaining > 0) return null; // Not enough iron
        }

        const totalCost = moneyCost + coalCost + ironCost;
        if (totalCost > player.money) return null;

        return {
            money: moneyCost,
            coal: coalNeeded,
            coalCost,
            iron: ironNeeded,
            ironCost,
            total: totalCost,
        };
    }

    executeBuild(playerId, cityId, slotIndex, industryType, cardIndex) {
        const isFarm = isBreweryFarm(cityId);

        // Validate cost before consuming the tile — calculateBuildCost uses getNextTile
        // internally, so calling useNextTile first would advance the tile pointer and
        // compute cost for the wrong (next-level) tile.
        const cost = this.calculateBuildCost(playerId, industryType, cityId);
        if (!cost) return { success: false, message: '钱不够，无法建造' };

        const tileData = this.state.useNextTile(playerId, industryType);
        if (!tileData) return { success: false, message: '没有可用的板块' };

        this.state._rec({ k: 'build', pid: playerId, type: industryType, level: tileData.level, loc: cityId, slot: isFarm ? null : slotIndex, base: cost.money, coalCost: cost.coalCost, ironCost: cost.ironCost });
        this.state.spendMoney(playerId, cost.total);

        // Consume coal
        if (cost.coal > 0) {
            let remaining = cost.coal;
            const sources = this.state.findCoalSource(cityId, playerId);
            for (const src of sources) {
                if (remaining <= 0) break;
                if (src.type === 'mine') {
                    this.state.consumeResource(src.key);
                    remaining--;
                } else if (src.type === 'market') {
                    this.state.takeMarketCoal();
                    remaining--;
                }
            }
        }

        // Consume iron
        if (cost.iron > 0) {
            let remaining = cost.iron;
            const sources = this.state.findIronSource(playerId);
            for (const src of sources) {
                if (remaining <= 0) break;
                if (src.type === 'works') {
                    this.state.consumeResource(src.key);
                    remaining--;
                } else if (src.type === 'market') {
                    this.state.takeMarketIron();
                    remaining--;
                }
            }
        }

        // Overbuilt tiles (own or opponent's) are removed from the game along
        // with any cubes on them; placement below simply overwrites the slot.

        // Breweries produce 1 beer when built in the Canal Era, 2 in the Rail
        // Era; coal mines / iron works use the cube count printed on the tile.
        let cubes = producedCubes(industryType, tileData, this.state.era);

        const placedTile = {
            playerId,
            type: industryType,
            tileData: tileData,
            flipped: false,
            resourceCubes: cubes,
        };

        let key;
        if (isFarm) {
            key = cityId; // farm tiles live in breweryFarmTiles by farm id
            this.state.breweryFarmTiles[cityId] = placedTile;
        } else {
            key = `${cityId}_${slotIndex}`;
            this.state.boardIndustries[key] = placedTile;
        }

        // Moving coal/iron to the market: iron works always sell their cubes
        // into empty market spaces immediately; coal mines only if connected
        // to a merchant location. Collected money goes straight to the player
        // (it is not "spent", so it doesn't affect turn order).
        let marketSale = null;
        if (industryType === INDUSTRY_TYPES.IRON_WORKS) {
            marketSale = this.state.autoSellToMarket(key, placedTile);
        } else if (industryType === INDUSTRY_TYPES.COAL_MINE) {
            const connected = this.state.getConnectedLocations(cityId);
            const merchantConnected = [...connected].some(loc => isMerchantLocation(loc));
            if (merchantConnected) {
                marketSale = this.state.autoSellToMarket(key, placedTile);
            }
        }
        if (marketSale && marketSale.moneyGained > 0) {
            this.state._rec({ k: 'gain', pid: playerId, amt: marketSale.moneyGained, why: 'tomkt' });
            this.state.players[playerId].money += marketSale.moneyGained;
        }

        // Discard the used card
        this.discardCard(playerId, cardIndex);

        const locName = isFarm ? BREWERY_FARMS[cityId].name : CITIES[cityId].name;
        let message = `在${locName}建造了 ${INDUSTRY_DISPLAY[industryType].name} Lv${tileData.level}`;
        if (marketSale && marketSale.cubesMoved > 0) {
            message += `，向市场卖出 ${marketSale.cubesMoved} 个得 £${marketSale.moneyGained}`;
            if (marketSale.flipped) message += '（板块已翻面！）';
        }
        return { success: true, message };
    }

    isResourceDepleted(industryType) {
        // Check if there are 0 resource cubes of this type anywhere on the board
        if (industryType === INDUSTRY_TYPES.COAL_MINE) {
            if (this.state.coalMarket > 0) return false;
            for (const tile of Object.values(this.state.boardIndustries)) {
                if (tile.type === INDUSTRY_TYPES.COAL_MINE && !tile.flipped && tile.resourceCubes > 0) {
                    return false;
                }
            }
            return true;
        }
        if (industryType === INDUSTRY_TYPES.IRON_WORKS) {
            if (this.state.ironMarket > 0) return false;
            for (const tile of Object.values(this.state.boardIndustries)) {
                if (tile.type === INDUSTRY_TYPES.IRON_WORKS && !tile.flipped && tile.resourceCubes > 0) {
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    // ========================================================================
    // NETWORK Action
    // ========================================================================

    getValidNetworkTargets(playerId) {
        const player = this.state.players[playerId];
        const targets = [];
        const era = this.state.era;

        for (const conn of CONNECTIONS) {
            if (this.state.boardLinks[conn.id]) continue; // Already built

            // Check era
            if (era === ERA.CANAL && !conn.canal) continue;
            if (era === ERA.RAIL && !conn.rail) continue;

            // Check if player has link tiles remaining
            if (era === ERA.CANAL && player.linksRemaining.canal <= 0) continue;
            if (era === ERA.RAIL && player.linksRemaining.rail <= 0) continue;

            // Check network connection (at least one end must be in network)
            // Exception: a player with nothing on the board may link anywhere
            if (!this.playerHasNoTilesOnBoard(playerId)) {
                const end1InNetwork = this.state.isInNetwork(playerId, conn.cities[0]);
                const end2InNetwork = this.state.isInNetwork(playerId, conn.cities[1]);
                if (!end1InNetwork && !end2InNetwork) continue;
            }

            // Check cost
            let cost;
            if (era === ERA.CANAL) {
                cost = CANAL_LINK_COST;
            } else {
                cost = RAIL_LINK_COST;
                // Rail also needs coal — check both endpoints, pick cheapest source
                const coalSource = this.findCheapestCoalForLink(conn, playerId);
                if (!coalSource) continue; // No coal available from either end
                cost += coalSource.free ? 0 : coalSource.price;
            }

            if (cost > player.money) continue;

            targets.push({
                connectionId: conn.id,
                cities: conn.cities,
                cost,
                type: era === ERA.CANAL ? 'canal' : 'rail',
            });
        }

        return targets;
    }

    executeNetwork(playerId, connectionId, cardIndex) {
        const player = this.state.players[playerId];
        const conn = CONNECTIONS.find(c => c.id === connectionId);
        if (!conn) return { success: false, message: '无效的连线' };

        const era = this.state.era;
        const linkType = era === ERA.CANAL ? 'canal' : 'rail';

        this.state._rec({ k: 'link', pid: playerId, type: linkType, conn: connectionId, a: conn.cities[0], b: conn.cities[1], base: era === ERA.CANAL ? CANAL_LINK_COST : RAIL_LINK_COST });
        // Pay cost
        if (era === ERA.CANAL) {
            this.state.spendMoney(playerId, CANAL_LINK_COST);
        } else {
            let totalCost = RAIL_LINK_COST;
            // Consume coal for rail — check both endpoints, use cheapest source
            const src = this.findCheapestCoalForLink(conn, playerId);
            if (src) {
                if (src.type === 'mine') {
                    this.state.consumeResource(src.key);
                } else {
                    totalCost += src.price;
                    this.state.takeMarketCoal();
                }
            }
            this.state.spendMoney(playerId, totalCost);
        }

        // Place link
        this.state.boardLinks[connectionId] = {
            playerId,
            type: linkType,
        };

        // Reduce remaining links
        if (linkType === 'canal') {
            player.linksRemaining.canal--;
        } else {
            player.linksRemaining.rail--;
        }

        // Discard card
        this.discardCard(playerId, cardIndex);

        const city1 = locationName(conn.cities[0]);
        const city2 = locationName(conn.cities[1]);

        return { success: true, message: `建造了${linkType === 'canal' ? '运河' : '铁路'}：${city1} - ${city2}` };
    }

    // ------------------------------------------------------------------
    // Double rail link (Rail Era only): 2 links for £15 total, 1 coal per
    // link (each sourced after its link is placed), plus 1 beer consumed
    // from a Brewery — merchant beer is NOT allowed, and an opponent's
    // brewery must be connected to the SECOND link.
    // ------------------------------------------------------------------

    // Candidate second links, assuming firstConnId has just been placed.
    getValidSecondRailLinks(playerId, firstConnId) {
        if (this.state.era !== ERA.RAIL) return [];
        const player = this.state.players[playerId];
        if (player.linksRemaining.rail < 2) return [];

        const firstConn = CONNECTIONS.find(c => c.id === firstConnId);
        if (!firstConn) return [];

        // Temporarily place the first link to evaluate second-link options
        const hadLink = this.state.boardLinks[firstConnId];
        this.state.boardLinks[firstConnId] = { playerId, type: 'rail' };

        // Also take the first link's coal (as executeNetworkDouble does), so a
        // mine's last cube is not offered to both links.
        let restoreCoal = null;
        const coal1 = this.findCheapestCoalForLink(firstConn, playerId);
        const coal1Cost = coal1 && !coal1.free ? coal1.price : 0;
        if (coal1 && coal1.type === 'mine') {
            const tile = this.state.boardIndustries[coal1.key];
            tile.resourceCubes--; restoreCoal = () => tile.resourceCubes++;
        } else if (coal1 && this.state.coalMarket > 0) {
            this.state.coalMarket--; restoreCoal = () => this.state.coalMarket++;
        }

        const targets = [];
        try {
            for (const conn of CONNECTIONS) {
                if (conn.id === firstConnId) continue;
                if (this.state.boardLinks[conn.id]) continue;
                if (!conn.rail) continue;

                const end1 = this.state.isInNetwork(playerId, conn.cities[0]);
                const end2 = this.state.isInNetwork(playerId, conn.cities[1]);
                if (!end1 && !end2) continue;

                // Coal for the second link (with the first link on the board).
                // Note: full affordability (£15 + both coals) is validated in
                // executeNetworkDouble; here we price the second coal only.
                const coalSource = this.findCheapestCoalForLink(conn, playerId);
                if (!coalSource) continue;

                // Beer: own breweries anywhere, or opponent breweries
                // connected to this (second) link. No merchant beer.
                const beer = this.findBeerForLink(playerId, conn);
                if (!beer) continue;

                // Both links' coal plus £15 must be affordable.
                const coal2Cost = coalSource.free ? 0 : coalSource.price;
                if (RAIL_DOUBLE_LINK_COST + coal1Cost + coal2Cost > player.money) continue;

                targets.push({
                    connectionId: conn.id,
                    cities: conn.cities,
                    coalCost: coalSource.free ? 0 : coalSource.price,
                });
            }
        } finally {
            if (restoreCoal) restoreCoal();
            if (hadLink) this.state.boardLinks[firstConnId] = hadLink;
            else delete this.state.boardLinks[firstConnId];
        }

        return targets;
    }

    // Find a beer barrel usable for a double-rail action on `conn`.
    findBeerForLink(playerId, conn) {
        // Own unflipped breweries: anywhere on the board
        for (const [key, tile] of Object.entries(this.state.boardIndustries)) {
            if (tile.type === INDUSTRY_TYPES.BREWERY && tile.playerId === playerId &&
                !tile.flipped && tile.resourceCubes > 0) {
                return { key };
            }
        }
        for (const [farmId, tile] of Object.entries(this.state.breweryFarmTiles)) {
            if (tile && tile.playerId === playerId && !tile.flipped && tile.resourceCubes > 0) {
                return { key: `farm_${farmId}` };
            }
        }
        // Opponent breweries: must be connected to the second link
        for (const endpoint of conn.cities) {
            const connected = this.state.getConnectedLocations(endpoint);
            for (const loc of connected) {
                if (isCity(loc)) {
                    const city = CITIES[loc];
                    for (let i = 0; i < city.slots.length; i++) {
                        const key = `${loc}_${i}`;
                        const tile = this.state.boardIndustries[key];
                        if (tile && tile.type === INDUSTRY_TYPES.BREWERY &&
                            tile.playerId !== playerId && !tile.flipped && tile.resourceCubes > 0) {
                            return { key };
                        }
                    }
                }
                if (isBreweryFarm(loc)) {
                    const tile = this.state.breweryFarmTiles[loc];
                    if (tile && tile.playerId !== playerId && !tile.flipped && tile.resourceCubes > 0) {
                        return { key: `farm_${loc}` };
                    }
                }
            }
        }
        return null;
    }

    executeNetworkDouble(playerId, connectionId1, connectionId2, cardIndex) {
        const player = this.state.players[playerId];
        const conn1 = CONNECTIONS.find(c => c.id === connectionId1);
        const conn2 = CONNECTIONS.find(c => c.id === connectionId2);
        if (!conn1 || !conn2) return { success: false, message: '无效的连线' };
        if (this.state.era !== ERA.RAIL) return { success: false, message: '只有铁路时代才能一次建两条铁路' };
        if (player.linksRemaining.rail < 2) return { success: false, message: '剩余铁路不足' };
        if (this.state.boardLinks[connectionId1] || this.state.boardLinks[connectionId2]) {
            return { success: false, message: '该连线已被建造' };
        }

        // --- Validation phase: place links and dry-run coal consumption ---
        // (mine cubes are decremented without flipping so the second link's
        // sourcing sees the first link's consumption; everything is undone
        // on failure, and flips are applied only on commit)
        const undo = [];
        const consumedMines = [];
        const dryConsumeCoal = (src) => {
            if (src.type === 'mine') {
                const tile = this.state.boardIndustries[src.key];
                tile.resourceCubes--;
                this.state._rec({ k: 'use', res: 'coal', key: src.key, owner: tile.playerId, level: tile.tileData.level });
                consumedMines.push({ key: src.key, tile });
                undo.push(() => tile.resourceCubes++);
            } else {
                this.state._rec({ k: 'mkt', res: 'coal', price: src.price, supply: this.state.coalMarket <= 0 });
                if (this.state.coalMarket > 0) {
                    this.state.coalMarket--;
                    undo.push(() => this.state.coalMarket++);
                }
            }
        };
        const fail = (message) => {
            while (undo.length) undo.pop()();
            return { success: false, message };
        };

        // Link 1: adjacency (or the empty-board exception), then coal
        const hasNoTiles = this.playerHasNoTilesOnBoard(playerId);
        if (!hasNoTiles &&
            !this.state.isInNetwork(playerId, conn1.cities[0]) &&
            !this.state.isInNetwork(playerId, conn1.cities[1])) {
            return fail('第一条铁路不与你的网络相邻');
        }
        this.state.boardLinks[connectionId1] = { playerId, type: 'rail' };
        undo.push(() => delete this.state.boardLinks[connectionId1]);

        const coalSrc1 = this.findCheapestCoalForLink(conn1, playerId);
        if (!coalSrc1) return fail('第一条铁路没有可用的煤炭');
        let totalCost = RAIL_DOUBLE_LINK_COST + (coalSrc1.free ? 0 : coalSrc1.price);
        dryConsumeCoal(coalSrc1);

        // Link 2: adjacency with link 1 on the board, then coal + beer
        if (!this.state.isInNetwork(playerId, conn2.cities[0]) &&
            !this.state.isInNetwork(playerId, conn2.cities[1])) {
            return fail('第二条铁路不与你的网络相邻');
        }
        this.state.boardLinks[connectionId2] = { playerId, type: 'rail' };
        undo.push(() => delete this.state.boardLinks[connectionId2]);

        const coalSrc2 = this.findCheapestCoalForLink(conn2, playerId);
        if (!coalSrc2) return fail('第二条铁路没有可用的煤炭');
        totalCost += coalSrc2.free ? 0 : coalSrc2.price;
        dryConsumeCoal(coalSrc2);

        const beer = this.findBeerForLink(playerId, conn2);
        if (!beer) return fail('第二条铁路没有可用的啤酒');
        if (totalCost > player.money) return fail('钱不够建两条铁路');

        // --- Commit ---
        this.state._rec({ k: 'link', pid: playerId, type: 'rail', conn: connectionId1, a: conn1.cities[0], b: conn1.cities[1], base: RAIL_DOUBLE_LINK_COST });
        this.state._rec({ k: 'link', pid: playerId, type: 'rail', conn: connectionId2, a: conn2.cities[0], b: conn2.cities[1], base: 0 });
        // Flip any mines the dry-run emptied (grants their owner income)
        for (const { key, tile } of consumedMines) {
            if (tile.resourceCubes <= 0) this.state.flipTile(key, tile);
        }
        this.state.consumeResource(beer.key);
        this.state.spendMoney(playerId, totalCost);
        player.linksRemaining.rail -= 2;
        this.discardCard(playerId, cardIndex);

        const name = id => locationName(id);
        return {
            success: true,
            message: `建造了 2 条铁路：${name(conn1.cities[0])} - ${name(conn1.cities[1])} 和 ${name(conn2.cities[0])} - ${name(conn2.cities[1])}（消耗 1 桶啤酒）`,
        };
    }

    // Find the cheapest coal source reachable from either endpoint of a connection.
    // Returns the best source object or null if no coal is available.
    findCheapestCoalForLink(conn, playerId) {
        const seen = new Set();
        const candidates = [];

        for (const cityId of conn.cities) {
            const sources = this.state.findCoalSource(cityId, playerId);
            for (const src of sources) {
                const dedupeKey = src.type === 'mine' ? src.key : 'market';
                if (!seen.has(dedupeKey)) {
                    seen.add(dedupeKey);
                    candidates.push(src);
                }
            }
        }

        if (candidates.length === 0) return null;
        // Prefer free (board mine) over market; among market entries pick lowest price
        candidates.sort((a, b) => (a.free ? 0 : a.price) - (b.free ? 0 : b.price));
        return candidates[0];
    }

    // ========================================================================
    // DEVELOP Action
    // ========================================================================

    canDevelop(playerId) {
        const player = this.state.players[playerId];
        // Need iron to develop (1 iron per tile removed)
        const ironSources = this.state.findIronSource(playerId);
        if (ironSources.length === 0) return false;

        // If the only iron available is from the market, player must be able to afford it
        const firstSource = ironSources[0];
        if (!firstSource.free && firstSource.price > player.money) return false;

        // Need at least one developable tile
        for (const [type, tiles] of Object.entries(player.industryTiles)) {
            const nextTile = tiles.find(t => !t.used);
            if (nextTile && nextTile.canDevelop) return true;
        }
        return false;
    }

    getDevelopableTypes(playerId) {
        const player = this.state.players[playerId];
        const types = [];
        for (const [type, tiles] of Object.entries(player.industryTiles)) {
            const nextTile = tiles.find(t => !t.used);
            if (nextTile && nextTile.canDevelop) {
                types.push({
                    type,
                    tile: nextTile,
                    name: INDUSTRY_DISPLAY[type].name,
                    level: nextTile.level,
                });
            }
        }
        return types;
    }

    executeDevelop(playerId, industryType1, industryType2, cardIndex) {
        // Develop removes 1 or 2 tiles from player mat (uses iron)
        // industryType2 can be null for single develop
        const player = this.state.players[playerId];

        // Validate iron availability and affordability before proceeding
        const tilesToDevelop = industryType2 ? 2 : 1;
        const ironSources = this.state.findIronSource(playerId);
        if (ironSources.length < tilesToDevelop) {
            return { success: false, message: '没有足够的铁' };
        }

        // Pre-check: can player afford market iron for each unit needed?
        let moneyNeeded = 0;
        for (let i = 0; i < tilesToDevelop; i++) {
            if (!ironSources[i].free) moneyNeeded += ironSources[i].price;
        }
        if (moneyNeeded > player.money) {
            return { success: false, message: '钱不够从市场买铁' };
        }

        // Consume iron (1 per tile developed)
        for (let i = 0; i < tilesToDevelop; i++) {
            const src = ironSources[i];
            if (src.type === 'works') {
                this.state.consumeResource(src.key);
            } else {
                // Buy from market (or the General Supply at £6 when empty)
                const price = this.state.getIronPrice();
                this.state.spendMoney(playerId, price);
                this.state.takeMarketIron();
            }
        }

        // Remove tiles from player mat
        const tile1 = this.state.developTile(playerId, industryType1);
        let tile2 = null;
        if (industryType2) {
            tile2 = this.state.developTile(playerId, industryType2);
        }

        // Discard card
        this.discardCard(playerId, cardIndex);

        let msg = `发展了 ${INDUSTRY_DISPLAY[industryType1].name}`;
        if (tile2) msg += ` 和 ${INDUSTRY_DISPLAY[industryType2].name}`;

        return { success: true, message: msg };
    }

    // ========================================================================
    // SELL Action
    // ========================================================================

    // The merchant tiles (by index) that a tile at cityId could sell to:
    // non-blank, accepting the industry type, and connected to the city.
    getSellMerchantsFor(playerId, cityId, industryType) {
        const connected = this.state.getConnectedLocations(cityId);
        const indices = [];
        for (let i = 0; i < this.state.merchantTiles.length; i++) {
            const mt = this.state.merchantTiles[i];
            if (mt.buys === 'blank') continue;
            if (!this.state.merchantTileAccepts(mt, industryType)) continue;
            if (!connected.has(mt.location)) continue;
            indices.push(i);
        }
        return indices;
    }

    getValidSellTargets(playerId) {
        const targets = [];

        for (const [key, tile] of Object.entries(this.state.boardIndustries)) {
            if (tile.playerId !== playerId) continue;
            if (tile.flipped) continue;
            if (!isSellableIndustry(tile.type)) continue;

            const [cityId] = key.split('_');

            // Every sale — even for tiles needing 0 beer — requires a
            // connected merchant tile that accepts this industry
            const merchantIndices = this.getSellMerchantsFor(playerId, cityId, tile.type);
            if (merchantIndices.length === 0) continue;

            // Beer requirement (merchant beer counts only from these merchants)
            const beerNeeded = tile.tileData.beersToSell || 0;
            if (beerNeeded > 0) {
                const beerSources = this.state.findBeerSources(cityId, playerId, merchantIndices);
                if (beerSources.length < beerNeeded) continue;
            }

            const merchantBeerAvailable = merchantIndices.some(i => this.state.merchantTiles[i].hasBeer);

            targets.push({
                key,
                cityId,
                tile,
                beerNeeded,
                merchantIndices,
                merchantBeerAvailable,
            });
        }

        return targets;
    }

    // Rough value ordering used to pick which merchant's beer to drink when
    // several are available (human UI offers a toggle, not a full picker).
    merchantBonusValue(mt) {
        const merchData = MERCHANTS[mt.location];
        if (!merchData) return 0;
        switch (merchData.bonusType) {
            case 'vp': return merchData.bonusAmount;
            case 'money': return merchData.bonusAmount * 0.4;
            case 'income': return 1.5;
            case 'develop': return 1.5;
            default: return 0;
        }
    }

    // ------------------------------------------------------------------
    // Beer for selling (Brass rules): each barrel a sale drinks may come
    // from the player's own breweries anywhere, an opponent's brewery
    // connected to the selling tile, or the merchant tile the good is sold
    // to (at most one merchant barrel per sale; it grants that merchant's
    // bonus). The player chooses; the engine validates the whole batch.
    // ------------------------------------------------------------------

    // Barrels currently on the board, by source id ('b:<key>' / 'm:<index>').
    beerStock() {
        const stock = {};
        const add = (key, tile) => {
            if (tile && tile.type === INDUSTRY_TYPES.BREWERY && !tile.flipped && tile.resourceCubes > 0) {
                stock['b:' + key] = tile.resourceCubes;
            }
        };
        for (const [key, tile] of Object.entries(this.state.boardIndustries)) add(key, tile);
        for (const [farmId, tile] of Object.entries(this.state.breweryFarmTiles || {})) add('farm_' + farmId, tile);
        this.state.merchantTiles.forEach((mt, i) => { if (mt.hasBeer) stock['m:' + i] = 1; });
        return stock;
    }

    // Human-readable name of a beer source; zh=true for the Chinese UI.
    // viewerId marks "own" breweries.
    beerSourceLabel(id, zh = true, viewerId = null) {
        if (id.startsWith('m:')) {
            const mt = this.state.merchantTiles[+id.slice(2)];
            const md = mt && MERCHANTS[mt.location];
            if (!md) return '商人啤酒';
            const n = md.bonusAmount;
            const bonus = zh
                ? ({ vp: `+${n} 分`, money: `+£${n}`, income: `收入 +${n} 格`, develop: `免费开发 ${n} 次` }[md.bonusType] || '')
                : ({ vp: `+${n} VP`, money: `+£${n}`, income: `+${n} income`, develop: 'free develop' }[md.bonusType] || '');
            return zh ? `商人啤酒 · ${md.name}（奖励 ${bonus}）` : `${md.name} merchant beer (${bonus})`;
        }
        const key = id.slice(2);
        const isFarm = key.startsWith('farm_');
        const tile = isFarm ? this.state.breweryFarmTiles[key.slice(5)] : this.state.boardIndustries[key];
        const where = isFarm
            ? (BREWERY_FARMS[key.slice(5)] ? BREWERY_FARMS[key.slice(5)].name : key)
            : (CITIES[key.split('_')[0]] ? CITIES[key.split('_')[0]].name : key);
        const ownerId = tile ? tile.playerId : null;
        const owner = ownerId !== null ? this.state.players[ownerId] : null;
        if (zh) return ownerId === viewerId ? `自己的酿酒厂 · ${where}` : `${owner ? owner.name : '对手'} 的酿酒厂 · ${where}`;
        return `${owner ? owner.name + "'s " : ''}brewery, ${where}`;
    }

    // Every beer source a sale of the tile at `key` may use, with the
    // barrels left on it right now. Own breweries first, then opponents'
    // connected breweries, then merchant beer (best bonus first).
    getSellBeerSources(playerId, key) {
        const tile = this.state.boardIndustries[key];
        if (!tile) return [];
        const [cityId] = key.split('_');
        const merchantIndices = this.getSellMerchantsFor(playerId, cityId, tile.type);
        const seen = new Set();
        const out = [];
        for (const s of this.state.findBeerSources(cityId, playerId, merchantIndices)) {
            const id = s.type === 'merchant' ? 'm:' + s.index : 'b:' + s.key;
            if (seen.has(id)) continue;
            seen.add(id);
            const src = { id, type: s.type, label: this.beerSourceLabel(id), labelZh: this.beerSourceLabel(id, true, playerId) };
            if (s.type === 'merchant') {
                src.index = s.index;
                src.count = 1;
                src.bonusValue = this.merchantBonusValue(this.state.merchantTiles[s.index]);
            } else {
                src.key = s.key;
                const t = s.key.startsWith('farm_') ? this.state.breweryFarmTiles[s.key.slice(5)] : this.state.boardIndustries[s.key];
                src.count = t ? t.resourceCubes : 0;
                src.ownerId = t ? t.playerId : null;
            }
            out.push(src);
        }
        const rank = { own: 0, opponent: 1, merchant: 2 };
        out.sort((a, b) => (rank[a.type] - rank[b.type]) || ((b.bonusValue || 0) - (a.bonusValue || 0)));
        return out;
    }

    // Validate a whole sell plan up front and decide every barrel.
    // sellPlan: [{ key, beer?: [sourceId...], useMerchantBeer? }]
    //  - with `beer`: exactly the barrels the player chose (validated)
    //  - without: picked automatically from what the explicit entries
    //    leave (merchant beer first when useMerchantBeer, then own
    //    breweries, then opponents'), searching all combinations so a
    //    batch that can be paid for is never rejected.
    // Returns { ok:true, steps:[{ key, tile, beer:[ids] }] } or
    // { ok:false, message, zh } — nothing is changed either way.
    resolveSellPlan(playerId, sellPlan) {
        const bad = (message, zh) => ({ ok: false, message: zh || message, zh: zh || message });
        if (!Array.isArray(sellPlan) || sellPlan.length === 0) {
            return bad('Select at least one industry to sell', '请选择要出售的产业');
        }
        const stock = this.beerStock();
        const steps = [];
        const autos = [];
        const seenKeys = new Set();
        const tileName = (tile, key) => {
            const city = CITIES[key.split('_')[0]];
            return { en: `${INDUSTRY_DISPLAY[tile.type].name} Lv${tile.tileData.level} in ${city ? city.name : key}`,
                     zh: `${city ? city.name : key} 的 ${INDUSTRY_DISPLAY[tile.type].name} Lv${tile.tileData.level}` };
        };

        for (const entry of sellPlan) {
            const key = entry && typeof entry.key === 'string' ? entry.key : null;
            const tile = key ? this.state.boardIndustries[key] : null;
            if (!tile || tile.playerId !== playerId || tile.flipped || !isSellableIndustry(tile.type)) {
                return bad('Invalid industry in sell plan', '出售列表里有无效的产业');
            }
            if (seenKeys.has(key)) return bad('An industry is listed twice', '同一个产业选了两次');
            seenKeys.add(key);
            const [cityId] = key.split('_');
            const name = tileName(tile, key);
            if (this.getSellMerchantsFor(playerId, cityId, tile.type).length === 0) {
                return bad(`${name.en}: no connected merchant buys it`, `${name.zh}：没有相连的商人收购`);
            }
            const need = tile.tileData.beersToSell || 0;
            const legal = this.getSellBeerSources(playerId, key);
            const step = { key, tile, need, legal, beer: [] };
            steps.push(step);

            if (Array.isArray(entry.beer)) {
                if (entry.beer.length !== need) {
                    return bad(`${name.en} needs ${need} beer (${entry.beer.length} chosen)`,
                               `${name.zh} 需要 ${need} 桶啤酒（选了 ${entry.beer.length} 桶）`);
                }
                const legalIds = new Set(legal.map(s => s.id));
                let merchantUsed = 0;
                for (const id of entry.beer) {
                    if (typeof id !== 'string' || !legalIds.has(id)) {
                        return bad(`${name.en} cannot use that beer`, `${name.zh} 不能用这桶啤酒（不相连或不存在）`);
                    }
                    if (id.startsWith('m:') && ++merchantUsed > 1) {
                        return bad(`${name.en}: at most one merchant barrel per sale`, `${name.zh}：每次出售最多用 1 桶商人啤酒`);
                    }
                    stock[id] = (stock[id] || 0) - 1;
                    if (stock[id] < 0) {
                        return bad(`Not enough beer left at ${this.beerSourceLabel(id)} for ${name.en}`,
                                   `啤酒不够：${this.beerSourceLabel(id, true, playerId)} 已被本次其它出售用完，${name.zh} 卖不了`);
                    }
                }
                step.beer = entry.beer.slice();
            } else if (need > 0) {
                const pref = legal.filter(s => entry.useMerchantBeer || s.type !== 'merchant')
                    .sort((a, b) => entry.useMerchantBeer
                        ? ((a.type === 'merchant' ? 0 : 1) - (b.type === 'merchant' ? 0 : 1))
                        : 0)
                    .map(s => s.id);
                autos.push({ step, pref, name });
            }
        }

        // Auto-pick the remaining barrels: depth-first, preferred order first
        const stockIds = Object.keys(stock);
        const failed = new Set(); // (tile index, barrels left) states known to be dead ends
        const assign = (ai) => {
            if (ai === autos.length) return true;
            const memo = ai + '|' + stockIds.map(id => stock[id]).join(',');
            if (failed.has(memo)) return false;
            if (assignTile(ai)) return true;
            failed.add(memo);
            return false;
        };
        const assignTile = (ai) => {
            const { step, pref } = autos[ai];
            const pick = (unit, from, merchantUsed) => {
                if (unit === step.need) return assign(ai + 1);
                for (let p = from; p < pref.length; p++) {
                    const id = pref[p];
                    if ((stock[id] || 0) <= 0) continue;
                    const isM = id.startsWith('m:');
                    if (isM && merchantUsed) continue;
                    stock[id]--; step.beer.push(id);
                    if (pick(unit + 1, p, merchantUsed || isM)) return true;
                    stock[id]++; step.beer.pop();
                }
                return false;
            };
            return pick(0, 0, false);
        };
        if (!assign(0)) {
            if (autos.length === 1 && sellPlan.length === 1) {
                const { step, name } = autos[0];
                return bad(`Not enough beer to sell ${name.en} (needs ${step.need})`, `啤酒不够，${name.zh} 卖不了（需要 ${step.need} 桶）`);
            }
            return bad('Not enough beer for all the selected industries together — sell fewer', '所选产业加起来啤酒不够，请少选几个');
        }
        return { ok: true, steps };
    }

    // sellPlan: see resolveSellPlan. All-or-nothing: if any tile in the
    // batch cannot be paid for, nothing is sold and nothing is consumed.
    // options.autoResolveDevelop: AI resolves Gloucester develop bonuses
    // immediately; for humans the count is returned for the UI to resolve.
    executeSell(playerId, sellPlan, cardIndex, options = {}) {
        const plan = this.resolveSellPlan(playerId, sellPlan);
        if (!plan.ok) return { success: false, message: plan.message, zh: plan.zh };

        const player = this.state.players[playerId];
        const results = [];
        let pendingDevelopBonuses = 0;

        for (const step of plan.steps) {
            const { key, tile } = step;
            const notes = [];
            for (const id of step.beer) {
                if (id.startsWith('m:')) {
                    // Consuming a merchant's beer grants that location's bonus
                    const mt = this.state.merchantTiles[+id.slice(2)];
                    mt.hasBeer = false;
                    const merchData = MERCHANTS[mt.location];
                    this.state._rec({ k: 'mbeer', pid: playerId, merchant: mt.location, name: merchData.name, bonus: merchData.bonusType, amt: merchData.bonusAmount, forKey: key });
                    switch (merchData.bonusType) {
                        case 'vp':
                            player.vp += merchData.bonusAmount;
                            notes.push(`+${merchData.bonusAmount} 分（${merchData.name}）`);
                            break;
                        case 'money':
                            player.money += merchData.bonusAmount;
                            this.state._rec({ k: 'gain', pid: playerId, amt: merchData.bonusAmount, why: 'merchant', name: merchData.name });
                            notes.push(`+£${merchData.bonusAmount}（${merchData.name}）`);
                            break;
                        case 'income':
                            this.state.advanceIncomeSpaces(playerId, merchData.bonusAmount);
                            notes.push(`收入 +${merchData.bonusAmount} 格（${merchData.name}）`);
                            break;
                        case 'develop':
                            if (options.autoResolveDevelop) {
                                const removed = this.applyFreeDevelop(playerId, merchData.bonusAmount);
                                if (removed.length) notes.push(`免费发展：${removed.join('、')}`);
                            } else {
                                pendingDevelopBonuses += merchData.bonusAmount;
                                notes.push(`获得免费发展（${merchData.name}）`);
                            }
                            break;
                    }
                } else {
                    notes.push(`啤酒：${this.beerSourceLabel(id, true, playerId)}`);
                    if (this.state._ledger) this.state._rec({ k: 'beerFor', forKey: key });
                    this.state.consumeResource(id.slice(2));
                }
            }

            // Flip the tile (advances income by the tile's spaces)
            this.state._rec({ k: 'sold', pid: playerId, key, type: tile.type, level: tile.tileData.level });
            this.state.flipTile(key, tile);

            let line = `出售了 ${INDUSTRY_DISPLAY[tile.type].name} Lv${tile.tileData.level}`;
            if (notes.length) line += `【${notes.join('；')}】`;
            results.push(line);
        }

        // Discard card
        this.discardCard(playerId, cardIndex);

        return {
            success: true,
            message: results.join('，'),
            pendingDevelopBonuses,
        };
    }

    // ========================================================================
    // LOAN Action
    // ========================================================================

    executeLoan(playerId, cardIndex) {
        if (!this.state.canTakeLoan(playerId)) {
            return { success: false, message: '贷款不能使收入低于 -10' };
        }
        const player = this.state.players[playerId];
        player.money += LOAN_AMOUNT;
        this.state._rec({ k: 'gain', pid: playerId, amt: LOAN_AMOUNT, why: 'loan' });
        this.state.applyLoanIncomeDrop(playerId);

        this.discardCard(playerId, cardIndex);

        return { success: true, message: `贷款 £${LOAN_AMOUNT}（收入 -${LOAN_INCOME_PENALTY} 级）` };
    }

    // ========================================================================
    // SCOUT Action
    // ========================================================================

    canScout(playerId) {
        const player = this.state.players[playerId];
        // Need at least 3 cards in hand (1 for action + 2 additional)
        if (player.hand.length < 3) return false;
        // Cannot have wild cards already
        if (player.hasWildLocation || player.hasWildIndustry) return false;
        // Must have wild cards available
        if (this.state.wildLocationPile <= 0 || this.state.wildIndustryPile <= 0) return false;
        return true;
    }

    executeScout(playerId, cardIndices) {
        // cardIndices: [actionCard, extraCard1, extraCard2] (3 cards total)
        const player = this.state.players[playerId];

        if (cardIndices.length !== 3) {
            return { success: false, message: '必须正好弃掉 3 张牌' };
        }

        // Remove cards in reverse index order to maintain indices
        const sorted = [...cardIndices].sort((a, b) => b - a);
        for (const idx of sorted) {
            this.state._rec({ k: 'discard', pid: playerId, card: this.cardLabel(player.hand[idx]) });
            player.hand.splice(idx, 1);
        }

        // Give wild cards
        player.hand.push({
            type: CARD_TYPES.WILD_LOCATION,
            name: '万能地点',
        });
        player.hand.push({
            type: CARD_TYPES.WILD_INDUSTRY,
            name: '万能产业',
        });

        player.hasWildLocation = true;
        player.hasWildIndustry = true;

        this.state.wildLocationPile--;
        this.state.wildIndustryPile--;

        return { success: true, message: '侦察：获得万能地点 + 万能产业' };
    }

    // ========================================================================
    // PASS Action
    // ========================================================================

    executePass(playerId, cardIndex) {
        this.discardCard(playerId, cardIndex);
        return { success: true, message: '跳过' };
    }

    // ========================================================================
    // Free Develop (merchant bonus)
    // ========================================================================

    // Gloucester bonus: remove tile(s) from the mat with no iron cost.
    // Auto-picks for the AI (canal-only tiles are most urgent to clear);
    // humans choose via the UI instead. Returns names of removed tiles.
    applyFreeDevelop(playerId, count, chosenType = null) {
        const removed = [];
        for (let i = 0; i < count; i++) {
            const types = this.getDevelopableTypes(playerId);
            if (types.length === 0) break;
            let pick;
            if (chosenType && types.some(t => t.type === chosenType)) {
                pick = types.find(t => t.type === chosenType);
            } else {
                // Prefer clearing canal-only (level 1) tiles, then lowest level
                types.sort((a, b) =>
                    (Number(b.tile.railEra === false) - Number(a.tile.railEra === false)) ||
                    (a.level - b.level));
                pick = types[0];
            }
            this.state.developTile(playerId, pick.type);
            removed.push(`${INDUSTRY_DISPLAY[pick.type].name} Lv${pick.level}`);
        }
        return removed;
    }

    // ========================================================================
    // Disabled Reason for Action Buttons
    // ========================================================================

    getDisabledReason(action, playerId) {
        const player = this.state.players[playerId];
        if (player.hand.length === 0) return '手牌为空';

        switch (action) {
            case ACTIONS.BUILD:
                if (this.getValidBuildTargets(playerId).length === 0) {
                    return '没有可建造的位置';
                }
                return null;
            case ACTIONS.NETWORK: {
                const era = this.state.era;
                if (era === ERA.CANAL && player.linksRemaining.canal <= 0) return '运河已用完';
                if (era === ERA.RAIL && player.linksRemaining.rail <= 0) return '铁路已用完';
                if (this.getValidNetworkTargets(playerId).length === 0) return '没有可建造的连线';
                return null;
            }
            case ACTIONS.DEVELOP: {
                const ironSources = this.state.findIronSource(playerId);
                if (ironSources.length === 0) return '没有可用的铁';
                if (!this.canDevelop(playerId)) return '玩家板上没有可发展的板块';
                return null;
            }
            case ACTIONS.SELL:
                if (this.getValidSellTargets(playerId).length === 0) return '没有可出售的产业';
                return null;
            case ACTIONS.LOAN:
                if (!this.state.canTakeLoan(playerId)) return '收入太低：贷款不能使收入低于 -10';
                return null;
            case ACTIONS.SCOUT:
                if (player.hand.length < 3) return '至少需要 3 张牌';
                if (player.hasWildLocation || player.hasWildIndustry) return '已持有万能牌';
                if (this.state.wildLocationPile <= 0 || this.state.wildIndustryPile <= 0) return '没有剩余的万能牌';
                return null;
            case ACTIONS.PASS:
                return null;
            default:
                return '未知动作';
        }
    }

    // ========================================================================
    // Card Management
    // ========================================================================

    cardLabel(card) {
        if (!card) return '';
        if (card.type === CARD_TYPES.LOCATION) return (CITIES[card.location] && CITIES[card.location].name) || card.name || card.location;
        if (card.type === CARD_TYPES.INDUSTRY) return (card.industryTypes || []).map(t => INDUSTRY_DISPLAY[t] ? INDUSTRY_DISPLAY[t].name : t).join('/') || card.name;
        return card.name || '万能牌';
    }

    discardCard(playerId, cardIndex) {
        const player = this.state.players[playerId];
        if (cardIndex < 0 || cardIndex >= player.hand.length) return;

        const card = player.hand[cardIndex];
        this.state._rec({ k: 'discard', pid: playerId, card: this.cardLabel(card) });

        // Wild cards go back to their piles
        if (card.type === CARD_TYPES.WILD_LOCATION) {
            this.state.wildLocationPile++;
            player.hasWildLocation = false;
        } else if (card.type === CARD_TYPES.WILD_INDUSTRY) {
            this.state.wildIndustryPile++;
            player.hasWildIndustry = false;
        }

        player.hand.splice(cardIndex, 1);
    }

    // ========================================================================
    // Get valid cards for an action
    // ========================================================================

    getValidCardsForAction(playerId, action, target = null) {
        const player = this.state.players[playerId];
        const validIndices = [];

        player.hand.forEach((card, idx) => {
            switch (action) {
                case ACTIONS.BUILD:
                    if (target) {
                        const isFarm = isBreweryFarm(target.cityId);
                        const industryCardOk = this.state.isInNetwork(playerId, target.cityId) ||
                            this.playerHasNoTilesOnBoard(playerId);
                        // Check if card matches the build target
                        if (card.type === CARD_TYPES.LOCATION && !isFarm && card.location === target.cityId) {
                            validIndices.push(idx);
                        } else if (card.type === CARD_TYPES.INDUSTRY &&
                                   card.industryTypes.includes(target.industryType)) {
                            if (industryCardOk) {
                                validIndices.push(idx);
                            }
                        } else if (card.type === CARD_TYPES.WILD_LOCATION && !isFarm) {
                            validIndices.push(idx);
                        } else if (card.type === CARD_TYPES.WILD_INDUSTRY) {
                            if (industryCardOk) {
                                validIndices.push(idx);
                            }
                        }
                    } else {
                        // Any card can potentially be used for build
                        validIndices.push(idx);
                    }
                    break;

                case ACTIONS.NETWORK:
                case ACTIONS.DEVELOP:
                case ACTIONS.SELL:
                case ACTIONS.LOAN:
                case ACTIONS.PASS:
                    // Any card can be discarded for these actions
                    validIndices.push(idx);
                    break;

                case ACTIONS.SCOUT:
                    // All cards are candidates for scout discard
                    validIndices.push(idx);
                    break;
            }
        });

        return validIndices;
    }
}
