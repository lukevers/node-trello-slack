'use strict';

var fs = require('fs')
   ,Trello = require('trello-events')
   ,Slack = require('node-slack');

var cfg, trello, slack, redis, handlers;
var mechanism = 'file';

module.exports = function(config){
	this.config = cfg = config;

	cfg.trello.boardChannels = {};
	for (var i = 0; i < cfg.trello.boards.length; i++){
		switch(typeof cfg.trello.boards[i]){
			case 'string':
				cfg.trello.boardChannels[cfg.trello.boards[i]] = cfg.slack.channel;
				break;
			case 'object':
				cfg.trello.boardChannels[cfg.trello.boards[i].id] = cfg.trello.boards[i].channel;
				cfg.trello.boards[i] = cfg.trello.boards[i].id;
				break;
			default:
				throw 'Unexpected boards array member type (' + typeof cfg.trello.boards[i] + ')';
		}
	}

	var allEvents = false;
	if (!cfg.trello.hasOwnProperty('events')){
		allEvents = true;
	}

	function wantsEvent( evt ){
		if (!cfg.trello.hasOwnProperty('events')){
			return false;
		}
		return cfg.trello.events.indexOf( evt ) > -1;
	}

	bootstrap(function(prev){
		cfg.minId = prev;
		slack = new Slack(cfg.slack.domain, cfg.slack.token);
		trello = new Trello(cfg);

		trello
			.on('maxId', writePrevId)
			.on('trelloError', function(err){
				console.error(err);
				process.exit(1);
			});

		if ( wantsEvent('createCard') || allEvents ){
			trello.on('createCard', handlers.createCard);
		}
		if ( wantsEvent('commentCard') || allEvents ){
			trello.on('commentCard', handlers.commentCard);
		}
		if ( wantsEvent('addAttachmentToCard') || allEvents ){
			trello.on('addAttachmentToCard', handlers.addAttachmentToCard);
		}
		if ( wantsEvent('updateCard') || allEvents ){
			trello.on('updateCard', handlers.updateCard);
		}
		if ( wantsEvent('updateCheckItemStateOnCard') || allEvents ){
			trello.on('updateCheckItemStateOnCard', handlers.updateCheckItemStateOnCard);
		}
	});
};

module.exports.prototype.getConfig = function(){
	return this.config;
};

/*
	handles the choice between redis and local files
*/
function bootstrap(callback){
	//if we can find a file named "last.id" then use that to store the activity timeline bookmark
	if (fs.existsSync('./last.id')){
		callback( fs.readFileSync('./last.id').toString() );
	}else{
		//redis!
		mechanism = 'redis';
		if (process.env.REDISTOGO_URL) {
			var rtg   = require('url').parse(process.env.REDISTOGO_URL);
			redis = require('redis').createClient(rtg.port, rtg.hostname);
			redis.auth(rtg.auth.split(':')[1]);
		} else {
			redis = require('redis').createClient();
		}
		redis.get('prevId', function(err, reply){
			if (err){
				console.error(err);
				process.exit(1);
			}
			if (reply === null){ reply = 0; }
			return callback(reply);
		});
	}
}

handlers = {
	createCard: function(event, boardId){
		var card_name = event.data.card.name
			,card_id = event.data.card.id
			,card_id_short = event.data.card.idShort
			,card_url = 'https://trello.com/card/' + card_id + '/' + boardId + '/' + card_id_short
			,author = event.memberCreator.fullName
			,board_url = 'https://trello.com/b/' + boardId
			,board_name = event.data.board.name
			,msg = ':boom: ' + author + ' created card <' + card_url + '|' + sanitize(card_name) + '> on board <' + board_url + '|' + board_name + '>';
		notify(cfg.trello.boardChannels[boardId], msg);
	}
	,commentCard: function(event, boardId){
		var card_id_short = event.data.card.idShort
			,card_id = event.data.card.id
			,card_url = 'https://trello.com/card/' + card_id + '/' + boardId + '/' + card_id_short
			,card_name = event.data.card.name
			,author = event.memberCreator.fullName
			,msg = ':speech_balloon: ' + author + ' commented on card <' + card_url + '|' + sanitize(card_name) + '>: ' + trunc(event.data.text);
		notify(cfg.trello.boardChannels[boardId], msg);
	}
	,addAttachmentToCard: function(event, boardId){
		var card_id_short = event.data.card.idShort
			,card_id = event.data.card.id
			,card_url = 'https://trello.com/card/' + card_id + '/' + boardId + '/' + card_id_short
			,card_name = event.data.card.name
			,author = event.memberCreator.fullName
			,aurl = event.data.attachment.url;
		var msg = ':paperclip: ' + author + ' added an attachment to card <' + card_url + '|' + sanitize(card_name) + '>: ' + '<' + aurl + '|' + sanitize(event.data.attachment.name) + '>';
		notify(cfg.trello.boardChannels[boardId], msg);
	}
	,updateCard: function(event, boardId){
		if (event.data.old.hasOwnProperty('idList') && event.data.card.hasOwnProperty('idList')){
			//moving between lists
			var oldId = event.data.old.idList
				,newId = event.data.card.idList
				,nameO,nameN
				,card_id_short = event.data.card.idShort
		      ,card_id = event.data.card.id
		      ,card_url = 'https://trello.com/card/' + card_id + '/' + boardId + '/' + card_id_short
		      ,card_name = event.data.card.name
			   ,author = event.memberCreator.fullName;
			trello.api.get('/1/list/' + oldId, function(err, resp){
				if (err) throw err;
				nameO = resp.name;
				trello.api.get('/1/list/' + newId, function(err, resp){
					if (err) throw err;
					nameN = resp.name;
					var msg = ':arrow_heading_up: ' + author + ' moved card <' + card_url + '|' + sanitize(card_name) + '> from list ' + nameO + ' to list ' + nameN;
					notify(cfg.trello.boardChannels[boardId], msg);
				});
			});
		}
	}
	,updateCheckItemStateOnCard: function(event, boardId){
		var card_id_short = event.data.card.idShort
			,card_id = event.data.card.id
			,card_url = 'https://trello.com/card/' + card_id + '/' + boardId + '/' + card_id_short
			,card_name = event.data.card.name
			,author = event.memberCreator.fullName;
		if (event.data.checkItem.state === 'complete'){
			var msg = ':ballot_box_with_check: ' + author + ' completed "' + event.data.checkItem.name + '" in card <' + card_url + '|' + sanitize(card_name) + '>.';
			notify(cfg.trello.boardChannels[boardId], msg);
		}
	}
};

function notify(room, msg, sender){
	sender = sender || 'Trello';
	slack.send({
		text: msg
		,channel: room
		,username: sender
		,icon_url: 'http://i.imgur.com/HJLfIU6.png'
	}, function(err){
		if (err){
			console.error('ERROR:\n', err);
			throw err;
		}
	});
}
function sanitize(msg){
	return msg.replace(/([><])/g, function(match, patt){
		return (
			patt === '>' ? '&gt;' :
			patt === '<' ? '&lt;' : ''
		);
	});
}
function trunc(s){
	s = s || '';
	if (s.length >= 200)
		return s.slice(0,199) + ' [...]';
	return s;
}
function writePrevId(valu){
	if (mechanism === 'file'){
		fs.writeFileSync('./last.id', valu);
	}else{
		redis.set('prevId', valu, function(err){
			if (err){
				console.error('Error setting new value to redis\n-----------------------------');
				console.error(err);
				process.exit(1);
			}
		});
	}
}
