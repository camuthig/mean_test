'use strict';

/**
 * Module dependencies.
 */
var mongoose = require('mongoose'),
	errorHandler = require('./errors'),
    winston = require('winston'),
    logger = winston.loggers.get('app_log'),
    async = require('async'),
    redis = require('redis'),
	Game = mongoose.model('Game'),
	Round = mongoose.model('Round'),
	Throw = mongoose.model('Throw'),
	_ = require('lodash');

function getGameAdapter(type) {
	var path = './games/games.' + type;
	return require(path);
}

/**
 * Create a Game
 */
function createLogic(req, next) {
	var game = new Game(req.body);
	game.current_thrower = game.player1;

	// Verify that the current user is at least one of
	// the players in the game.
	if(req.user._id.toString() !== req.body.player1.toString() &&
		req.user._id.toString() !== req.body.player2.toString()) {
		return next({
            status: 403,
			error: {
                code: 403,
                error: 'forbidden',
				message: 'You must be one of the players in the created game.'
			}
		});
	}

	var adapter = getGameAdapter(game.game_type.toLowerCase());
	game.scoreboard = adapter.createScoreboard();

	game.save(function(err) {
		if (err) {
            logger.error('Unable to save created game.', {message: errorHandler.getErrorMessage(err)});
			next({
                status: 500,
				error: {
                    code: 500,
                    error: 'internal',
					message: errorHandler.getErrorMessage(err)
				}
			});
		} else {
			return next(game);
		}
	});
}

module.exports.createLogic = createLogic;

exports.create = function(req, res) {
	createLogic(req, function(result) {
		if ('error' in result) {
			return res.status(result.status).send({error: result.error});
		} else {
			res.jsonp(result);
		}
	});
};

/**
 * Show the current Game
 */
exports.read = function(req, res) {
	res.jsonp(req.game);
};

/**
 * Validate the update request input for the game.
 * @param  {Request}	req  	The Express request
 * @param  {Function} 	next 	The callback function to execute next
 */
function validateUpdateRequst(req, next) {
	var round = req.body.round;
	var errors = {error: {}};
    var fields = {};

	// Invalid round data would be:
	// 		Number not in 1-20 or 25
	// 		Multiplier not between 1 and 3
	// 		Number 25 and Multiplier 3
	// 		More than three throws in a round
	if (_.size(round) > 3) {
        logger.error('More than three throws were included in the round.', {user: req.user.id});
        next(
            {
                status: 400,
                error: {
                    code: 400,
                    error: 'invalid_request',
                    message: 'There can only be three throws per round.'
                }
            });
	}
	for (var index = 1; index <= _.size(round); index++) {
		var index_errors = [];
		if ( round[index].number &&
                !(round[index].number >= 1 && round[index].number <= 20) &&
                (round[index].number !== 25 && round[index.number !== 'bull'])) {
            logger.error(
                'A non-existing number was provided for the throw.',
                {
                    user: req.user.id,
                    'throw': round[index]
                });
			index_errors.push({
				message: 'The number is not a valid value on a dart board.'
			});
		}
		if ( round[index].multiplier &&
                !(round[index].multiplier >=1 &&
                round[index].multiplier <= 3)) {
            logger.error(
                'A non-existing multipler was provided for the throw.',
                {
                    user: req.user.id,
                    'throw': round[index]
                });
			index_errors.push({
				message: 'The multiplier is not a valid value on a dart board.'
			});
		}
		if ((round[index].number === 25 || round[index].number === 'bull') && round[index].multiplier === 3) {
            logger.error('Triple bull was provided for the throw.',{user: req.user.id});
			index_errors.push({
				message: 'There is no triple bulls eye on the board.'
			});
		}
        if ( (round[index].number && !round[index].multiplier) || (!round[index].number && round[index].multiplier)) {
            logger.error(
                'The multiplier or number was missing for the throw.',
                {
                    user: req.user.id,
                    'throw': round[index]
                });
            index_errors.push({
                message: 'Both the number and multiplier must be provided.'
            });
        }

		if (_.size(index_errors) !== 0) {
		  fields[index] = index_errors;
		}
	}

    if(!(_.isEmpty(fields))) {
        errors.status = 422;
        errors.error.code = 422;
        errors.error.error = 'invalid_fields';
        errors.error.fields = fields;
    }

	next(errors);
}

/**
 * Store the data on the round for performance tracking
 * @param   {Request}   req         	The express request
 * @param   {Game}      game_id     	The id of the Game object the round is part of
 * @param   {User}      user_id     	The id of the User object the round is linked to
 * @param	{int}		round_number	The order of the round in the game
 */
function saveRound(req, game_id, user_id, round_number) {
    var round = new Round({game: game_id, user: user_id, order: round_number});
    round.save(function(err) {
        if (err) {
            logger.error('Error saving the round: ' + errorHandler.getErrorMessage(err));
        }
        else {
            for (var index = 1; index <= _.size(req.body.round); index++) {
                req.body.round[index].round = round;
                var dart = new Throw(req.body.round[index]);
                // We'll ignore the issue of defining the function here since the
                // functionality is simple and performance in the async scenario
                // is of little concern.
                /* jshint loopfunc:true */
                dart.save(function(err) {
                    if(err) {
                        logger.error('Error saving throw: ' + errorHandler.getErrorMessage(err));
                    }
                });
            }
        }
    });
}

/**
 * Update the game using the game adapter and input round data.
 * @param  {Request}    req     The express request
 * @param  {Function}   next    The function to call next
 * @return {Game}               An update game object
 */
function updateLogic(req, next) {
    var game = req.game ;

    if(game.winner){
        logger.error('The game is already completed.', {game: game.id});
        return next({
            status: 400,
            error: {
                code: 400,
                error: 'invalid_request',
                message: 'This game is already completed.'
            }
        });
    }

    validateUpdateRequst(req, function(errors) {
        if(!(_.isEmpty(errors.error))) {
            return next(errors);
        } else{
            var adapter = getGameAdapter(game.game_type.toLowerCase());
            game = adapter.updateGameWithRound(req.body.round, game);

			// Update the current thrower and round number
            var old_thrower = game.current_thrower;
			var old_round = game.current_round;
			if (game.current_thrower.id === game.player1.id) {
				game.current_thrower = game.player2;
			} else {
				game.current_thrower = game.player1;
				// Only update the round number of player2 just threw
				game.current_round++;
			}

            game.save(function(err) {
                if (err) {
                    logger.error('Error saving the game after round update.', {error: errorHandler.getErrorMessage(err)});
                    return next({
                        status: 500,
                        error: {
                            code: 500,
                            error: 'internal',
                            message: errorHandler.getErrorMessage(err)
                        }
                    });
                } else {
                    // If winner has just been set, we need to ensure we populate the
                    // displayName value from the database.
                    if(game.winner) {
                        game.populate({path: 'winner', select: 'displayName'}, function(err, game) {
                            if (err) {
                                logger.error('Error populating the winner displayName after round update.', {error: errorHandler.getErrorMessage(err)});
                                return next({
                                    status: 500,
                                    error: {
                                        code: 500,
                                        error: 'internal',
                                        message: errorHandler.getErrorMessage(err)
                                    }
                                });
                            } else {
                                return next(game);
                            }
                        });
                    }
                    else {
                        return next(game);
                    }
                }
            });

            // Save the round information
            saveRound(req, game._id, old_thrower.id, old_round);
        }
    });
}

module.exports.updateLogic = updateLogic;

/**
 * Update a Game
 */
exports.update = function(req, res) {
	updateLogic(req, function(result) {
        if ('error' in result) {
            console.log(result);
            return res.status(result.status).send({error: result.error});
        } else {
            res.jsonp(result);
        }
    });
};

/**
 * Delete an Game
 */
exports.delete = function(req, res) {
	var game = req.game ;

	game.remove(function(err) {
		if (err) {
			return res.status(500).send({
                code: 500,
                error: 'internal',
				message: errorHandler.getErrorMessage(err)
			});
		} else {
			res.jsonp(game);
		}
	});
};

/**
 * List of Games
 */
exports.list = function(req, res) { Game.find().sort('-created').
	populate('player1', 'displayName').
	populate('player2', 'displayName').
	populate('current_thrower', 'displayName').
	populate('winner', 'displayName').
	exec(function(err, games) {
		if (err) {
			return res.status(500).send({
                code: 500,
                error: 'internal',
				message: errorHandler.getErrorMessage(err)
			});
		} else {
			res.jsonp(games);
		}
	});
};

/**
 * Game middleware
 */
exports.gameByID = function(req, res, next, id) { Game.findById(id).
	populate('player1', 'displayName').
	populate('player2', 'displayName').
	populate('current_thrower', 'displayName').
	populate('winner', 'displayName').
	exec(function(err, game) {
		if (err) {
            winston.error(
                'Unable to find game in database.',
                {err: err});
            if (err.name === 'CastError') {
                res.status(404).send(
                    {
                        code: 404,
                        error: 'not_found',
                        message: 'Unable to find the game.'
                    });
            } else {
                res.status(500).send(
                    {
                        code: 500,
                        error: 'internal',
                        message: 'Error getting game from the database.'
                    });
            }
            return;
        }
		if (! game) return next(new Error('Failed to load Game ' + id));
		req.game = game ;
		next();
	});
};

/**
 * Validate that the current user has sufficient permissions to update the
 * current thrower's round information
 * @param {Request} req The Express request
 * @return {Boolean} True if the user should be allowed to update, False otherwise.
 */
exports.isUpdatePermitted = function(req, res, next) {
    // Check to see if the current thrower and user are the same.
    // If not, create a Redis client and get the TTL of the accept_update key.
    // If it is less than or equal to 0 we can't allow the update.
    if (req.user._id.toString() === req.game.current_thrower._id.toString()) {
        next();
    } else {
        async.waterfall([
            function(callback) {
                var client = redis.createClient();
                client.on('ready', function(err){callback(err, client);});
            },
            function(client, callback) {
                var accept_key = req.game._id.toString() + '_' + req.game.current_thrower._id.toString() + '_opponent_update_accept';
                client.ttl(accept_key, function(err, result){callback(err, result, client);});
            },
            function(result, client) {
                if(result <= 0) {
                    winston.error(
                        'Attempt to update user round without permission.',
                        {
                            request_user: req.user._id.toString(),
                            update_user: req.game.current_thrower._id.toString(),
                            game: req.game._id.toString()
                        }
                    );
                    return res.status(403).send({
                        error:{
                            code: 401,
                            error: 'not_authorized',
                            message: 'You are not permitted to update round information for this user'
                        }
                    });
                } else {
                    // We don't need to verify that the updater is the opponent, since hasAuthorization
                    // will ensure anyone hitting the update route is one of the two players of the game.
					var accept_key = req.game._id.toString() + '_opponent_update_accept';
					client.expire(accept_key, 600, function(err) {
						if(err) {
							winston.error(
							'Unable to update update_accept key for game.',
							{err: err, game: req.game._id});
						}
					});
					next();
                }
            }],
            function(err) {
                winston.error(errorHandler.getErrorMessage(err), {game: req.game._id});
            });
    }
};

/**
 * A method that implements the logic of allowing an oppent to keep score of both
 * players temporarily. This is done by placing a key into the Redis server
 * @param {Request} 	req 	The Express request
 * @param {Response} 	res 	The Express response
 */
exports.giveScoreAuthorization = function(req, res) {
	async.waterfall([
		function(callback) {
			var client = redis.createClient();
			client.on('ready', function(err){callback(err, client);});
		},
		function(client, callback) {
			var key = req.game._id.toString() + '_' + req.game.current_thrower._id.toString() + '_opponent_update_accept';
			client.set(key, true, function(err, result){
				if (err) {
					winston.error(
						'Unable to create update_accept key for game.',
						{err: errorHandler.getErrorMessage(err), game: req.game._id.toString()});
					return res.status(400).send({
						message: errorHandler.getErrorMessage(err)
					});
				} else {
					callback(err, client, key);
				}
			});

		},
		function(client, key, callback) {
			client.expire(key, 600, function(err, result){
				if (err) {
					winston.error(
						'Unable to set expire on update_accept key for game.',
						{err: errorHandler.getErrorMessage(err), game: req.game._id.toString()});
					return res.status(400).send({
						message: errorHandler.getErrorMessage(err)
					});
				} else {
					res.status(200).send({success: true});
				}
			});
		}],
		function(err) {
			winston.error(errorHandler.getErrorMessage(err), {game: req.game._id});
		}
	);
};

/**
 * Game authorization middleware
 */
exports.hasAuthorization = function(req, res, next) {
	if (req.game.player1.id !== req.user.id && req.game.player2.id !== req.user.id) {
		return res.status(403).send(
            {
                error: {
                    code: 403,
                    error: 'not_allowed',
                    message: 'User is not authorized to update this game at all.'
                }
            });
	}
	next();
};
