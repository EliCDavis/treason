/*
 * Copyright 2015-2016 Christopher Brown and Jackie Niebling.
 *
 * This work is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License.
 *
 * To view a copy of this license, visit http://creativecommons.org/licenses/by-nc/4.0/ or send a letter to:
 *     Creative Commons
 *     PO Box 1866
 *     Mountain View
 *     CA 94042
 *     USA
 */
'use strict';

var fs = require('fs');
var randomGen = require('random-seed');
var lodash = require('lodash');
var createAiPlayer = require('./ai-player');
var shared = require('./web/shared');
var dataAccess = require('./dataaccess');
var actions = shared.actions;
var stateNames = shared.states;
var GameTracker = require('./game-tracker');

var format = require('util').format;
var inherits = require('util').inherits;
var deepcopy = require('deepcopy');
var escape = require('validator').escape;
var EventEmitter = require('events').EventEmitter;

var nextGameId = 1;

var MIN_PLAYERS = 2;
var MAX_PLAYERS = 6;

var epithets = fs.readFileSync(__dirname + '/epithets.txt', 'utf8').split(/\r?\n/);

module.exports = function createGame(options) {
    options = options || {};
    var gameId = nextGameId++;

    var state = {
        stateId: 1,
        gameId: gameId,
        players: [],
        numPlayers: 0,
        gameName: options.gameName,
        created: options.created,
        roles: [],
        state: {
            name: stateNames.WAITING_FOR_PLAYERS
        }
    };

    var rand = randomGen.create(options.randomSeed);

    dataAccess.setDebug(options.debug);

    var gameStats = dataAccess.constructGameStats();
    var gameTracker;

    var players = [];
    var allows = [];
    var proxies = [];

    var turnHistGroup = 1;
    var adhocHistGroup = 1;

    var deck;
    var _test_fixedDeck = false;

    var game = new EventEmitter();
    game.canJoin = canJoin;
    game.playerJoined = playerJoined;
    game._test_setTurnState = _test_setTurnState;
    game._test_setInfluence = _test_setInfluence;
    game._test_setCash = _test_setCash;
    game._test_setDeck = _test_setDeck;
    game._test_resetAllows = resetAllows;

    function playerJoined(player) {
        var isObserver = !canJoin();

        var playerState = {
            name: playerName(player.name),
            cash: 2,
            influenceCount: 2,
            influence: [
                {
                    role: 'not dealt',
                    revealed: false
                },
                {
                    role: 'not dealt',
                    revealed: false
                }
            ],
            isObserver: isObserver,
            ai: !!player.ai
        };

        if (isObserver) {
            playerState.cash = 0;
            playerState.influenceCount = 0;
            playerState.influence = [];
        }

        var playerIdx = state.players.length;
        state.players.push(playerState);
        players.push(player);
        state.numPlayers++;

        addHistory('player-joined', nextAdhocHistGroup(), playerState.name + ' joined the game' + (isObserver ? ' as an observer' : ''));
        emitState();

        var proxy = createGameProxy(playerIdx);
        if (isObserver) {
            proxy.command = function () {};
        }
        proxies.push(proxy);
        return proxy;
    }

    // Related history items are grouped together using history group ids, defined below.

    // History items relating to a turn: playing an action, blocking, being challenged, etc.
    function curTurnHistGroup() {
        return 't' + turnHistGroup;
    }

    // Ad-hoc events, like a player leaving the game, can occur in the middle of a turn, but should be grouped separately.
    function nextAdhocHistGroup() {
        return 'a' + (++adhocHistGroup);
    }

    function curAdhocHistGroup() {
        return 'a' + adhocHistGroup;
    }

    function playerName(name) {
        name = name || 'Anonymous';
        for (var i = 0; i < state.players.length; i++) {
            if (state.players[i].name == name) {
                var epithet = epithets[rand(epithets.length)];
                return playerName(name + ' ' + epithet);
            }
        }
        return name;
    }

    function createGameProxy(playerIdx, oldProxy) {
        var proxy = oldProxy || {};
        proxy.command = function (data) {
            command(playerIdx, data);
        };
        proxy.playerLeft = function (rejoined) {
            playerLeft(playerIdx, rejoined);
        };
        proxy.sendChatMessage = function (message) {
            sendChatMessage(playerIdx, message);
        };
        proxy.getGameName = function () {
            return state.gameName;
        };
        return proxy;
    }

    function playerLeft(playerIdx, rejoined) {
        if (playerIdx == null || playerIdx < 0 || playerIdx >= state.numPlayers) {
            throw new GameException('Unknown player disconnected');
        }
        var player = state.players[playerIdx];
        if (!player) {
            throw new GameException('Unknown player disconnected');
        }
        var playerId = players[playerIdx].playerId;
        var historySuffix = [];
        if (state.state.name == stateNames.WAITING_FOR_PLAYERS || player.isObserver) {
            state.players.splice(playerIdx, 1);
            players.splice(playerIdx, 1);
            proxies.splice(playerIdx, 1);
            state.numPlayers--;
            // Rewire the player proxies with the new player index
            for (var i = playerIdx; i < state.numPlayers; i++) {
                createGameProxy(i, proxies[i]);
            }
        } else {
            players[playerIdx] = null;
            if (state.state.name != stateNames.GAME_WON) {
                gameTracker.playerLeft(playerIdx);
                // Reveal all the player's influence.
                var influence = player.influence;
                for (var j = 0; j < influence.length; j++) {
                    if (!influence[j].revealed) {
                        historySuffix.push(format('{%d} revealed %s', playerIdx, influence[j].role));
                        influence[j].revealed = true;
                    }
                }
                //If the player was eliminated already or an observer, we do not record a disconnect
                if (playerId && player.influenceCount > 0) {
                    //Record the stats on the game
                    gameStats.playerDisconnect.unshift(playerId);
                    //Record the stats individually, in case the game does not finish
                    //Should not be recorded if the player is the last human player
                    if (!onlyAiLeft()) {
                        dataAccess.recordPlayerDisconnect(playerId);
                    }
                }
                player.influenceCount = 0;
                var end = checkForGameEnd();
                if (!end) {
                    if (state.state.playerIdx == playerIdx) {
                        nextTurn();
                    } else if (state.state.name == stateNames.REVEAL_INFLUENCE && state.state.playerToReveal == playerIdx) {
                        nextTurn();
                    } else if ((state.state.name == stateNames.ACTION_RESPONSE || state.state.name == stateNames.BLOCK_RESPONSE)
                        && !allows[playerIdx]) {
                        allow(playerIdx);
                    }
                }
            }
        }

        addHistory('player-left', nextAdhocHistGroup(), player.name + ' left the game' + (rejoined ? ' to play again' : ''));
        for (var k = 0; k < historySuffix.length; k++) {
            addHistory('player-left', curAdhocHistGroup(), historySuffix[k]);
        }
        if (onlyAiLeft()) {
            destroyGame();
        }
        emitState();
    }

    function removeAiPlayer() {
        for (var i = players.length - 1; i > 0; i--) {
            if (players[i] && players[i].ai) {
                playerLeft(i);
                return;
            }
        }
    }

    function onlyAiLeft() {
        for (var i = 0; i < players.length; i++) {
            if (players[i] && !players[i].ai) {
                return false;
            }
        }
        return true;
    }

    function destroyGame() {
        debug('destroying game');
        players = [];
        proxies = [];
        setState({
            name: 'destroyed'
        })
        game.emit('end');
    }

    function afterPlayerDeath(playerIdx) {
        gameStats.playerRank.unshift(players[playerIdx].playerId);
        addHistory('player-died', nextAdhocHistGroup(), '{%d} suffered a humiliating defeat', playerIdx);
        checkForGameEnd();
    }

    function checkForGameEnd() {
        var winnerIdx = null;
        for (var i = 0; i < state.players.length; i++) {
            if (state.players[i].influenceCount > 0) {
                if (winnerIdx == null) {
                    winnerIdx = i;
                } else {
                    winnerIdx = null;
                    break;
                }
            }
        }
        if (winnerIdx != null) {
            setState({
                name: stateNames.GAME_WON,
                playerIdx: winnerIdx
            });
            gameTracker.gameOver(state);
            var playerId = players[winnerIdx].playerId;
            gameStats.playerRank.unshift(playerId);
            gameStats.events = gameTracker.pack().toString('base64');
            dataAccess.recordGameData(gameStats);
            game.emit('end');
            return true;
        } else {
            return false;
        }
    }

    function getInfluence(player) {
        var influence = [];
        for (var i = 0; i < player.influence.length; i++) {
            if (!player.influence[i].revealed) {
                influence.push(player.influence[i].role);
            }
        }
        return influence;
    }

    function emitState() {
        state.stateId++;
        debug(state);
        for (var i = 0; i < state.players.length; i++) {
            var masked = maskState(i);
            emitStateAsync(i, masked);
        }
    }

    function emitStateAsync(playerIdx, state) {
        setTimeout(function () {
            if (players[playerIdx] != null) {
                players[playerIdx].onStateChange(state);
            }
        }, 0);
    }

    /**
     * Mask hidden influences, add player-specific data.
     */
    function maskState(playerIdx) {
        var masked = deepcopy(state);
        for (var i = 0; i < state.players.length; i++) {
            if (i != playerIdx) {
                var influence = masked.players[i].influence;
                for (var j = 0; j < influence.length; j++) {
                    if (!influence[j].revealed) {
                        influence[j].role = 'unknown';
                    }
                }
            }
        }
        // If a player is exchanging or interrogating, show the roles to that player alone.
        if (state.state.playerIdx != playerIdx) {
            masked.state.exchangeOptions = [];
            masked.state.confession = null;
        }
        masked.playerIdx = playerIdx;
        return masked;
    }

    function start(gameType) {
        if (state.state.name != stateNames.WAITING_FOR_PLAYERS) {
            throw new GameException('Incorrect state');
        }
        if (state.numPlayers >= MIN_PLAYERS) {
            gameStats.gameType = gameType || 'original';
            state.roles = ['duke', 'captain', 'assassin', 'contessa'];
            if (gameStats.gameType === 'inquisitors') {
                state.roles.push('inquisitor');
            }
            else {
                state.roles.push('ambassador');
            }
            deck = buildDeck();
            gameTracker = new GameTracker();

            var nonObservers = [];

            for (var i = 0; i < state.numPlayers; i++) {
                var player = state.players[i];

                if (!player.isObserver) {
                    for (var j = 0; j < 2; j++) {
                        player.influence[j].role = deck.pop();
                    }

                    gameStats.players++;
                    if (!player.ai) {
                        gameStats.humanPlayers++;
                    }

                    nonObservers.push(i);
                }
            }

            var firstPlayer;
            if (typeof options.firstPlayer === 'number') {
                firstPlayer = options.firstPlayer;
            }
            else {
                firstPlayer = nonObservers[rand(nonObservers.length)];
            }
            turnHistGroup++;
            setState({
                name: stateNames.START_OF_TURN,
                playerIdx: firstPlayer
            });
            gameTracker.startOfTurn(state);
        }
    }

    function getGameRole(roles) {
        return lodash.intersection(state.roles, lodash.flatten([roles]))[0];
    }

    function command(playerIdx, command) {
        debug('command from player: ' + playerIdx);
        debug(command);
        var i, action, message;
        var player = state.players[playerIdx];
        if (player == null) {
            throw new GameException('Unknown player');
        }
        if (command.stateId != state.stateId) {
            throw new GameException('Stale state (' + command.stateId + '!=' + state.stateId + ')');
        }
        if (command.command == 'start') {
            start(command.gameType);

        } else if (command.command == 'add-ai') {
            if (state.state.name != stateNames.WAITING_FOR_PLAYERS) {
                throw new GameException('Incorrect state');
            }
            createAiPlayer(game, options);

        } else if (command.command == 'remove-ai') {
            if (state.state.name != stateNames.WAITING_FOR_PLAYERS) {
                throw new GameException('Incorrect state');
            }
            removeAiPlayer();

        } else if (command.command == 'play-action') {
            if (state.state.name != stateNames.START_OF_TURN) {
                throw new GameException('Incorrect state');
            }
            if (state.state.playerIdx != playerIdx) {
                throw new GameException('Not your turn');
            }
            action = actions[command.action];
            if (action == null) {
                throw new GameException('Unknown action');
            }
            if (action.roles && !getGameRole(action.roles)) {
                throw new GameException('Action not allowed in this game');
            }
            if (player.cash >= 10 && command.action != 'coup') {
                throw new GameException('You must coup with >= 10 cash');
            }
            if (player.cash < action.cost) {
                throw new GameException('Not enough cash');
            }
            if (action.targeted) {
                if (command.target == null) {
                    throw new GameException('No target specified');
                }
                if (command.target < 0 || command.target >= state.numPlayers) {
                    throw new GameException('Invalid target specified');
                }
                if (state.players[command.target].influenceCount == 0) {
                    throw new GameException('Cannot target dead player');
                }
            }
            gameTracker.action(command.action, command.target);
            player.cash -= action.cost;
            if (action.roles == null && action.blockedBy == null) {
                if (playAction(playerIdx, command, false)) {
                    nextTurn();
                }
            } else {
                debug('checking for blocks/challenges');
                if (command.action == 'steal') {
                    message = format('{%d} attempted to steal from {%d}', playerIdx, command.target);
                } else if (command.action == 'assassinate') {
                    message = format('{%d} attempted to assassinate {%d}', playerIdx, command.target);
                } else if (command.action == 'exchange') {
                    message = format('{%d} attempted to exchange', playerIdx);
                } else if (command.action == 'interrogate') {
                    message = format('{%d} attempted to interrogate {%d}', playerIdx, command.target);
                } else {
                    message = format('{%d} attempted to draw %s', playerIdx, command.action);
                }
                setState({
                    name: stateNames.ACTION_RESPONSE,
                    playerIdx: playerIdx,
                    action: command.action,
                    target: command.target,
                    message: message
                });
                resetAllows(playerIdx);
            }

        } else if (command.command == 'challenge') {
            if (player.influenceCount == 0) {
                throw new GameException('Dead players cannot challenge');
            }
            if (state.state.name == stateNames.ACTION_RESPONSE) {
                if (playerIdx == state.state.playerIdx) {
                    throw new GameException('Cannot challenge your own action');
                }
                action = actions[state.state.action];
                if (!action) {
                    throw new GameException('Unknown action');
                }
                if (!action.roles) {
                    throw new GameException('Action cannot be challenged');
                }
                challenge(playerIdx, state.state.playerIdx, getGameRole(action.roles));

            } else if (state.state.name == stateNames.BLOCK_RESPONSE) {
                if (playerIdx == state.state.target) {
                    throw new GameException('Cannot challenge your own block');
                }
                challenge(playerIdx, state.state.target, state.state.blockingRole);

            } else {
                throw new GameException('Incorrect state');
            }

        } else if (command.command == 'reveal') {
            if (state.state.name != stateNames.REVEAL_INFLUENCE) {
                throw new GameException('Incorrect state');
            }
            if (state.state.playerToReveal != playerIdx) {
                throw new GameException('Not your turn to reveal an influence');
            }
            for (i = 0; i < player.influence.length; i++) {
                var influence = player.influence[i];
                if (influence.role == command.role && !influence.revealed) {
                    influence.revealed = true;
                    player.influenceCount--;
                    addHistory(state.state.reason, curTurnHistGroup(), '%s; {%d} revealed %s', state.state.message, playerIdx, command.role);
                    if (state.state.reason == 'incorrect-challenge') {
                        if (afterIncorrectChallenge()) {
                            nextTurn();
                        }
                    } else if (state.state.reason == 'successful-challenge') {
                        if (afterSuccessfulChallenge()) {
                            nextTurn();
                        }
                    } else {
                        // The reveal is due to a coup or assassination.
                        nextTurn();
                    }
                    emitState();
                    return;
                }
            }
            throw new GameException('Could not reveal role');

        } else if (command.command == 'block') {
            if (player.influenceCount == 0) {
                throw new GameException('Dead players cannot block');
            }
            if (state.state.name != stateNames.ACTION_RESPONSE && state.state.name != stateNames.FINAL_ACTION_RESPONSE) {
                throw new GameException('Incorrect state');
            }
            action = actions[state.state.action];
            if (!action) {
                throw new GameException('Unknown action');
            }
            if (playerIdx == state.state.playerIdx) {
                throw new GameException('Cannot block your own action');
            }
            if (!action.blockedBy) {
                throw new GameException('Action cannot be blocked');
            }
            if (!command.blockingRole) {
                throw new GameException('No blocking role specified');
            }
            if (state.roles.indexOf(command.blockingRole) < 0) {
                throw new GameException('Role not valid in this game');
            }
            if (action.blockedBy.indexOf(command.blockingRole) < 0) {
                throw new GameException('Action cannot be blocked by that role');
            }
            // Original player is in the playerIdx field; blocking player is in the target field.
            if (state.state.name == stateNames.ACTION_RESPONSE) {
                addHistory(state.state.action, curTurnHistGroup(), state.state.message);
            }
            gameTracker.block(target, command.blockingRole);
            setState({
                name: stateNames.BLOCK_RESPONSE,
                playerIdx: state.state.playerIdx,
                action: state.state.action,
                target: playerIdx,
                blockingRole: command.blockingRole,
                message: format('{%d} attempted to block with ' + command.blockingRole, playerIdx)
            });
            resetAllows(playerIdx);

        } else if (command.command == 'allow') {
            if (player.influenceCount == 0) {
                throw new GameException('Dead players cannot allow actions');
            }
            var stateChanged = allow(playerIdx);
            if (!stateChanged) {
                // Do not emit state.
                return;
            }

        } else if (command.command == 'exchange') {
            if (state.state.name != stateNames.EXCHANGE) {
                throw new GameException('Incorrect state');
            }
            if (state.state.playerIdx != playerIdx) {
                throw new GameException('Not your turn');
            }
            if (!command.roles) {
                throw new GameException('Must specify roles to exchange');
            }
            if (command.roles.length != player.influenceCount) {
                throw new GameException('Wrong number of roles');
            }
            var unchosen = arrayDifference(state.state.exchangeOptions, command.roles);
            if (!unchosen) {
                throw new GameException('Invalid choice of roles');
            }
            // Assign the roles the player selected.
            for (i = 0; i < player.influence.length; i++) {
                if (!player.influence[i].revealed) {
                    player.influence[i].role = command.roles.pop()
                }
            }
            // Return the other roles to the deck.
            deck = shuffle(deck.concat(unchosen));
            addHistory('exchange', curTurnHistGroup(), '{%d} exchanged roles', playerIdx);
            nextTurn();

        } else if (command.command == 'interrogate') {
            if (state.state.name != stateNames.INTERROGATE) {
                throw new GameException('Incorrect state');
            }
            if (state.state.playerIdx != playerIdx) {
                throw new GameException('Not your turn');
            }
            // Send a history event only to the player who was interrogated.
            addHistoryAsync(
                state.state.target,
                'interrogate',
                curTurnHistGroup(),
                format('{%d} saw your %s', playerIdx, state.state.confession));
            if (command.forceExchange) {
                var target = state.players[state.state.target];
                var idx = indexOfInfluence(target, state.state.confession);
                if (idx == null) {
                    throw new GameException('Target does not have the confessed role');
                }
                target.influence[idx].role = swapRole(state.state.confession);
                addHistory('interrogate', curTurnHistGroup(), '{%d} forced {%d} to exchange roles', playerIdx, state.state.target);
            }
            else {
                addHistory('interrogate', curTurnHistGroup(), '{%d} allowed {%d} to keep the same roles', playerIdx, state.state.target);
            }
            nextTurn();

        } else {
            throw new GameException('Unknown command');
        }

        emitState();
    }

    function allow(playerIdx) {
        if (state.state.name == stateNames.BLOCK_RESPONSE) {
            if (state.state.target == playerIdx) {
                throw new GameException('Cannot allow your own block');
            }
            allows[playerIdx] = true;
            if (everyoneAllows()) {
                addHistory('block', curTurnHistGroup(), '{%d} blocked with %s', state.state.target, state.state.blockingRole);
                nextTurn();
                return true;
            } else {
                return false;
            }
        } else if (state.state.name == stateNames.ACTION_RESPONSE || state.state.name == stateNames.FINAL_ACTION_RESPONSE) {
            if (state.state.playerIdx == playerIdx) {
                throw new GameException('Cannot allow your own action');
            }
            if (state.state.name == stateNames.FINAL_ACTION_RESPONSE) {
                if (state.state.target != playerIdx) {
                    throw new GameException('Only the targetted player can allow the action');
                }
            } else {
                allows[playerIdx] = true;
                if (!everyoneAllows()) {
                    return false;
                }
            }
            if (playAction(state.state.playerIdx, state.state)) {
                nextTurn();
            }
            return true;
        } else {
            throw new GameException('Incorrect state');
        }
    }

    function afterSuccessfulChallenge() {
        // The reveal is due to a successful challenge.
        if (state.state.blockingRole) {
            // A block was successfully challenged - the action goes ahead.
            return playAction(state.state.playerIdx, state.state, true);
        } else {
            // The original action was successfully challenged - it does not happen - next turn.
            return true;
        }
    }

    function afterIncorrectChallenge() {
        var action = actions[state.state.action];

        // The reveal is due to a failed challenge.
        if (state.state.blockingRole) {
            // A block was incorrectly challenged - the action is blocked - next turn.
            return true;
        } else {
            // The original action was challenged.
            var target = state.players[state.state.target];
            if (action.blockedBy && target.influenceCount > 0) {
                // The targeted player has a final chance to block the action.
                setState({
                    name: stateNames.FINAL_ACTION_RESPONSE,
                    playerIdx: state.state.playerIdx,
                    action: state.state.action,
                    target: state.state.target,
                    message: state.state.message
                });
                return false;
            } else {
                // The action cannot be blocked - it goes ahead.
                return playAction(state.state.playerIdx, state.state, true);
            }
        }
    }

    function arrayDifference(array, subarray) {
        array = deepcopy(array);
        for (var i = 0; i < subarray.length; i++) {
            var idx = array.indexOf(subarray[i]);
            if (idx == -1) {
                return false;
            }
            array.splice(idx, 1);
        }
        return array;
    }

    function resetAllows(initiatingPlayerIdx) {
        allows = [];
        // The player who took the action does not need to allow it.
        allows[initiatingPlayerIdx] = true;
    }

    function everyoneAllows() {
        for (var i = 0; i < state.numPlayers; i++) {
            if (state.players[i].influenceCount == 0) {
                // We don't care whether dead players allowed the action.
                continue;
            }
            if (!allows[i]) {
                return false;
            }
        }
        return true;
    }

    function challenge(playerIdx, challengedPlayerIdx, challegedRole) {
        var revealedRole, endOfTurn;
        var player = state.players[playerIdx];
        var challengedPlayer = state.players[challengedPlayerIdx];
        if (!challengedPlayer) {
            throw new GameException('Cannot identify challenged player');
        }
        if (state.state.blockingRole) {
            // A block is being challenged - log it (<player> attempted to block with <role>).
            addHistory('block', curTurnHistGroup(), state.state.message);
        } else {
            // An action is being challenged - log it (<player> attempted to <action>).
            addHistory(state.state.action, curTurnHistGroup(), state.state.message);
        }

        var influenceIdx = indexOfInfluence(challengedPlayer, challegedRole);
        if (influenceIdx != null) {
            // Player has role - challenge lost.
            gameTracker.challenge(playerIdx, challengedPlayerIdx, false);

            // Deal the challenged player a replacement card.
            var oldRole = challengedPlayer.influence[influenceIdx].role;
            challengedPlayer.influence[influenceIdx].role = swapRole(oldRole);

            var message = format('{%d} incorrectly challenged {%d}; {%d} exchanged %s for a new role',
                playerIdx, challengedPlayerIdx, challengedPlayerIdx, oldRole);

            // If the challenger is losing their last influence,
            if (player.influenceCount <= 1) {
                // Then the challenger is dead. Reveal an influence.
                revealedRole = revealFirstInfluence(player);
                addHistory('incorrect-challenge', curTurnHistGroup(), '%s; {%d} revealed %s', message, playerIdx, revealedRole);

                endOfTurn = afterIncorrectChallenge();

                afterPlayerDeath(playerIdx);

                if (endOfTurn) {
                    nextTurn();
                }
            } else {
                // The action will take place after the reveal.
                setState({
                    name: stateNames.REVEAL_INFLUENCE,
                    playerIdx: state.state.playerIdx,
                    action: state.state.action,
                    target: state.state.target,
                    blockingRole: state.state.blockingRole,
                    message: message,
                    reason: 'incorrect-challenge',
                    playerToReveal: playerIdx
                });
            }
        } else {
            // Player does not have role - challenge won.
            gameTracker.challenge(playerIdx, challengedPlayerIdx, true);
            var message = format('{%d} successfully challenged {%d}', playerIdx, challengedPlayerIdx);

            // If someone assassinates you, you bluff contessa, and they challenge you, then you lose two influence: one for the assassination, one for the successful challenge.
            var wouldLoseTwoInfluences = state.state.name == stateNames.BLOCK_RESPONSE && state.state.action == 'assassinate' &&
                state.state.target == challengedPlayerIdx;

            // If the challenged player is losing their last influence,
            if (challengedPlayer.influenceCount <= 1 || wouldLoseTwoInfluences) {
                // Then the challenged player is dead. Reveal an influence.
                revealedRole = revealFirstInfluence(challengedPlayer);
                addHistory('successful-challenge', curTurnHistGroup(), '%s; {%d} revealed %s', message, challengedPlayerIdx, revealedRole);

                if (challengedPlayer.influenceCount == 0) {
                    afterPlayerDeath(challengedPlayerIdx);
                }

                endOfTurn = afterSuccessfulChallenge();

                if (endOfTurn) {
                    nextTurn();
                }
            } else {
                setState({
                    name: stateNames.REVEAL_INFLUENCE,
                    playerIdx: state.state.playerIdx,
                    action: state.state.action,
                    target: state.state.target,
                    blockingRole: state.state.blockingRole,
                    message: message,
                    reason: 'successful-challenge',
                    playerToReveal: challengedPlayerIdx
                });
            }
        }
    }

    function revealFirstInfluence(player) {
        var influence = player.influence;
        for (var j = 0; j < influence.length; j++) {
            if (!influence[j].revealed) {
                influence[j].revealed = true;
                player.influenceCount--;
                return influence[j].role;
            }
        }
        return null;
    }

    function playAction(playerIdx, actionState) {
        debug('playing action');
        var target, message, revealedRole;
        var player = state.players[playerIdx];
        var action = actions[actionState.action];
        player.cash += action.gain || 0;
        if (actionState.action == 'assassinate') {
            message = format('{%d} assassinated {%d}', playerIdx, actionState.target);
            target = state.players[actionState.target];
            if (target.influenceCount == 1) {
                revealedRole = revealFirstInfluence(target);
                addHistory('assassinate', curTurnHistGroup(), '%s; {%d} revealed %s', message, actionState.target, revealedRole);
                afterPlayerDeath(actionState.target);
            } else if (target.influenceCount > 1) {
                setState({
                    name: stateNames.REVEAL_INFLUENCE,
                    playerIdx: state.state.playerIdx,
                    action: actionState.action,
                    target: actionState.target,
                    blockingRole: actionState.blockingRole,
                    message: message,
                    reason: 'assassinate',
                    playerToReveal: actionState.target
                });
                return false; // Not yet end of turn
            }
        } else if (actionState.action == 'coup') {
            message = format('{%d} staged a coup on {%d}', playerIdx, actionState.target);
            target = state.players[actionState.target];
            if (target.influenceCount <= 1) {
                revealedRole = revealFirstInfluence(target);
                addHistory('coup', curTurnHistGroup(), '%s; {%d} revealed %s', message, actionState.target, revealedRole);
                afterPlayerDeath(actionState.target);
            } else {
                setState({
                    name: stateNames.REVEAL_INFLUENCE,
                    playerIdx: state.state.playerIdx,
                    action: actionState.action,
                    target: actionState.target,
                    blockingRole: actionState.blockingRole,
                    message: message,
                    reason: 'coup',
                    playerToReveal: actionState.target
                });
                return false; // Not yet end of turn
            }
        } else if (actionState.action == 'steal') {
            target = state.players[actionState.target];
            addHistory('steal', curTurnHistGroup(), '{%d} stole from {%d}', playerIdx, actionState.target);
            if (target.cash >= 2) {
                target.cash -= 2;
                player.cash += 2;
            } else {
                player.cash += target.cash;
                target.cash = 0;
            }
        } else if (actionState.action == 'exchange') {
            var exchangeOptions = [deck.pop()].concat(getInfluence(player));
            if (state.roles.indexOf('ambassador') !== -1) {
                // Ambassadors draw two cards; inquisitors draw one.
                exchangeOptions.unshift(deck.pop());
            }
            setState({
                name: stateNames.EXCHANGE,
                playerIdx: state.state.playerIdx,
                action: actionState.action,
                exchangeOptions: exchangeOptions
            });
            return false; // Not yet end of turn
        } else if (actionState.action == 'interrogate') {
            target = state.players[actionState.target];
            var influence = getInfluence(target);
            var confession = influence[rand(influence.length)];
            setState({
                name: stateNames.INTERROGATE,
                playerIdx: state.state.playerIdx,
                action: actionState.action,
                target: state.state.target,
                confession: confession
            });
            return false; // Not yet end of turn
        } else {
            // Income or foreign aid.
            addHistory(actionState.action, curTurnHistGroup(), '{%d} drew %s', playerIdx, actionState.action);
        }
        return true; // End of turn
    }

    function setState(s) {
        debug('State change from ' + state.state.name + ' to ' + s.name);
        state.state = s;
    }

    function swapRole(role) {
        deck.push(role);
        deck = shuffle(deck);
        return deck.pop();
    }

    function nextTurn() {
        debug('next turn');
        if (state.state.name != stateNames.GAME_WON) {
            turnHistGroup++;
            setState({
                name: stateNames.START_OF_TURN,
                playerIdx: nextPlayerIdx()
            });
            gameTracker.startOfTurn(state);
        }
    }

    function indexOfInfluence(player, role) {
        for (var i = 0; i < player.influence.length; i++) {
            if (player.influence[i].role == role && !player.influence[i].revealed) {
                return i;
            }
        }
        return null;
    }

    function nextPlayerIdx() {
        var playerIdx = state.state.playerIdx;
        for (var i = 1; i < state.numPlayers; i++) {
            var candidateIdx = (playerIdx + i) % state.numPlayers;
            if (state.players[candidateIdx].influenceCount > 0) {
                return candidateIdx;
            }
        }
        debug('no more players');
        return null;
    }

    function debug(obj) {
        if (options.debug) {
            console.log(obj);
        }
    }

    function shuffle(array) {
        if (_test_fixedDeck) {
            return array;
        }
        var shuffled = [];
        while (array.length) {
            var i = rand(array.length);
            var e = array.splice(i, 1);
            shuffled.push(e[0]);
        }
        return shuffled;
    }

    function buildDeck() {
        var deck = [];
        for (var i = 0; i < 3; i++) {
            deck = deck.concat(state.roles);
        }
        return shuffle(deck);
    }

    function addHistory(/*type, histGroup, format_string, format_args...*/) {
        var args = Array.prototype.slice.apply(arguments);
        var type = args.shift();
        var histGroup = args.shift();
        var message = format.apply(null, args);

        if (options.logger) {
            options.logger.log('info', 'game %d: %s', gameId, message);
        }
        for (var i = 0; i < state.numPlayers; i++) {
            addHistoryAsync(i, type, histGroup, message);
        }
    }

    function addHistoryAsync(dest, type, histGroup, message) {
        setTimeout(function () {
            if (players[dest] != null) {
                players[dest].onHistoryEvent(message, type, histGroup);
            }
        }, 0);
    }

    // Returns whether another person can join as an actual player.
    // If it returns false, you can still join as an observer.
    function canJoin() {
        return state.state.name == stateNames.WAITING_FOR_PLAYERS && state.players.length < MAX_PLAYERS;
    }

    function sendChatMessage(playerIdx, message) {
        message = escape(message).substring(0, 1000);
        for (var i = 0; i < players.length; i++) {
            sendChatMessageAsync(i, playerIdx, message);
        }
    }

    function sendChatMessageAsync(dest, playerIdx, message) {
        if (players[dest] != null) {
            players[dest].onChatMessage(playerIdx, message);
        }
    }

    function _test_setTurnState(turn, emit) {
        setState(turn);
        if (emit) {
            emitState();
        }
    }

    function _test_setInfluence(/*playerIdx, role, role*/) {
        var args = Array.prototype.slice.apply(arguments);
        var playerIdx = args.shift();
        var influence = state.players[playerIdx].influence;
        state.players[playerIdx].influenceCount = args.length;
        for (var i = 0; i < influence.length; i++) {
            var role = args.shift();
            if (role) {
                influence[i].role = role;
                influence[i].revealed = false;
            } else {
                influence[i].revealed = true;
            }
        }
    }

    function _test_setCash(playerIdx, cash) {
        state.players[playerIdx].cash = cash;
    }

    function _test_setDeck(d) {
        deck = d;
        _test_fixedDeck = true;
    }

    return game;
};

function GameException(message) {
    this.message = message;
}
