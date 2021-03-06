'use strict';

var path = require('path');
var fs = require('fs');

var pivotal = require('pivotal');
var log = require('npmlog');
var request = require('hyperquest');
var async = require('async');
var FormData = require('form-data');
var Trello = require('node-trello');

var PROXY = process.env.PROXY || '';
var VERBOSE = process.env.VERBOSE || false;
var trelloAPI = process.env.TRELLO_API || 'https://api.trello.com';
var requiredLists = ['accepted', 'delivered', 'rejected', 'finished', 'current', 'backlog', 'icebox'];

if(PROXY){
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function organizeLists(trelloLists){
  var list = trelloLists.reduce(function(a, list){
    a[list.name.toLowerCase()] = list;
    return a;
  }, {});
  return list;
}

function addChecklistsToCard(trello, cardId, items, name, cb){
  // we have to create a checkilst itself before we can add items to it...
  trello.post('/1/cards/'+cardId+'/checklists', function(err, checklist){
    if(err){
      return cb(err);
    }

    var tasks = [];

    items.forEach(function(checkItem){
      if(VERBOSE){
        log.info('pivotal-to-trello', 'adding checkItem: %s for %s', checkItem.description, name);
      }
      var checkItemPayload = {
        name: checkItem.description,
        pos: checkItem.position,
        idChecklist: checklist.id,
        checked: checkItem.complete
      };

      var checkItemURI = '/1/checklists/'+checklist.id+'/checkItems';

      tasks.push(function(cb){
        trello.post(checkItemURI, checkItemPayload, cb);
      });
    });

    async.parallel(tasks, function(err){
      if(err){
        return cb(err);
      }
      cb();
    });
  });
}

function addCommentsToCard(trello, cardId, comments, name, cb){
  var tasks = [];
  comments.forEach(function(comment){
    if(VERBOSE){
      log.info('pivotal-to-trello', 'adding comment: %s for %s', comment.text, name);
    }
    var commentPayload = {
      text: comment.text
    };
    tasks.push(function(cb){
      trello.post('/1/cards/'+cardId+'/comments', commentPayload, cb);
    });
  });

  async.parallel(tasks, function(err){
    if(err){
      return cb(err);
    }
    cb();
  });
}

function addAttachmentsToCard(key, token, pivotal, cardId, attachments, name, cb){
  var attachmentsURI = trelloAPI+'/1/cards/'+cardId+'/attachments?key='+key+'&token='+token;
  var tasks = [];


  var makeAttachment = function(attachment, cb){
    log.info('pivotal-to-trello', 'adding attachment: %s for %s', attachment.filename, name);

    var fn = path.join('/tmp', path.basename(attachment.filename));
    var s = fs.createWriteStream(fn);

    s.on('error', function(err){
      log.error('pivotal-to-trello', err);
    });

    s.on('close', function(){
      fs.readFile(fn, function(err, data){
        if(err){
          return cb(err);
        }

        // the trello API is VERY pedantic about what it recieves and for
        // some reason request wasn't doing it right, so we'll build
        // the request using form-data and hyperquest ourselves
        var form = new FormData();
        form.append('name', attachment.filename);
        form.append('file', data, {filename: fn});
        var headers = form.getHeaders();
        headers['content-length'] = form.getLengthSync();

        var req = request(attachmentsURI, {
          method: 'POST',
          headers: headers
        });

        req.on('error', function(err){
          log.error('pivotal-to-trello', 'Could not create attachment', err);
          log.error('pivotal-to-trello', attachment);
          return cb();
        });

        req.on('response', function(res){
          if(res.statusCode !== 200){
            log.error('pivotal-to-trello', 'Could not create attachment', res.statusCode);
            res.pipe(process.stderr);
          }
          return cb();
        });

        form.pipe(req);

      });
    });

    var pivotalRequest = request(attachment.url, {
      headers: {
        'X-TrackerToken': pivotal
      }});

    pivotalRequest.on('response', function(res){
      res.pipe(s);
    });
  };

  attachments.forEach(function(attachment){
    tasks.push(makeAttachment.bind(null, attachment));
  });

  async.parallel(tasks, function(err){
    if(err){
      cb(err);
    }
    cb();
  });
}

function attachCardData(trello, key, token, pivotal, story, card, cb){
  var tasks, notes, attachments;
  var asyncTasks = [];

  if(story.tasks && story.tasks.task){
    tasks =  Array.isArray(story.tasks.task) ? story.tasks.task : [story.tasks.task];
    asyncTasks.push(function(cb){
      addChecklistsToCard(trello, card.id, tasks, story.name, cb);
    });
  }

  if(story.notes && story.notes.note){
    notes = Array.isArray(story.notes.note) ? story.notes.note : [story.notes.note];
    asyncTasks.push(function(cb){
      addCommentsToCard(trello, card.id, notes, story.name, cb);
    });
  }

  if(story.attachments && story.attachments.attachment){
    attachments = Array.isArray(story.attachments.attachment) ? story.attachments.attachment : [story.attachments.attachment];
    asyncTasks.push(function(cb){
      addAttachmentsToCard(key, token, pivotal, card.id, attachments, story.name, cb);
    });
  }

  async.parallel(asyncTasks, function(err){
    if(err){
      return cb(err);
    }
    cb();
  });
}

function createTrelloCard(trello, key, token, pivotal, lists, story, storyIndex, cb){
  var destList = story.current_state.toLowerCase();

  if(destList === 'unscheduled'){
    destList = 'icebox';
  } else if(destList === 'unstarted'){
    destList = 'backlog';
  } else if(destList === 'started'){
    destList = 'current';
  }

  var trelloList = lists[destList].id;
  var labels = [story.story_type];
  if(story.labels){
    labels = labels.concat(story.labels);
  }
  var trelloPayload = {
    name: story.name,
    desc: story.description || '',
    labels: labels,
    pos: storyIndex,
    idList: trelloList
  };

  trello.post('/1/cards', trelloPayload, function(err, card){
    log.info('pivotal-to-trello', 'migrating', story.id, story.name);
    if(err){
      return cb(err);
    }

    attachCardData(trello, key, token, pivotal, story, card, cb);
  });
}

function createTrelloCards(trello, opts, lists, stories, cb){
  var tasks = [];
  stories.story.forEach(function(story, storyIndex){
    tasks.push(createTrelloCard.bind(null, trello, opts.trello_key, opts.trello_token, opts.pivotal, lists, story, storyIndex));
  });

  async.parallel(tasks, function(err){
    if(err){
      return cb(err);
    }
    cb();
  });
}

function readPivotalStories(pivotal, trello, opts, cb){
  var lists = organizeLists(opts.lists);

  pivotal.getStories(opts.from, {}, function(err, stories){
    if(err){
      return cb(err);
    }
    createTrelloCards(trello, opts, lists, stories, cb);
  });
}

function makeLists(needed, opts, trello, pivotal, cb){
  var tasks = [];
  var boardUrl = '/1/boards/'+opts.to+'/lists';

  needed.forEach(function(list){
    var listPayload = {
      name: list
    };
    tasks.push(function(cb){
      trello.post(boardUrl, listPayload, cb);
    });
  });

  async.parallel(tasks, function(err, res){
    opts.lists = opts.lists.concat(res);
    readPivotalStories(pivotal, trello, opts, cb);
  });
}

function verifyLists(lists, opts, trello, pivotal, cb){
  var needed = requiredLists.slice(0);
  if(Array.isArray(lists)){
    lists.forEach(function(list){
      var idx = needed.indexOf(list.name.toLowerCase());
      if(idx > -1){
        needed.splice(idx, 1);
        opts.lists.push(list);
      }
    });

    if(needed.length > 0){
      log.info('pivotal-to-trello', 'The following lists will be created:', needed.join(', '));
      makeLists(needed, opts, trello, pivotal, cb);
    } else {
      readPivotalStories(pivotal, trello, opts, cb);
    }
  } else {
    log.error('pivotal-to-trello', 'Sorry, there was an error with getting the lists on your board from Trello');
    process.exit(1);
  }
}

function getListsFromBoard(trello, opts, cb){
  trello.get('/1/boards/'+opts.to+'/lists', function(err, res){
    if(err){
      return cb(err);
    }
    return verifyLists(res, opts, trello, pivotal, cb);
  });
}

function importer(opts){
  opts.lists = [];
  var trello = new Trello(opts.trello_key, opts.trello_token);
  pivotal.useToken(opts.pivotal);

  getListsFromBoard(trello, opts, function(err){
    if(err){
      log.error('pivotal-to-trello', err);
      process.exit(1);
    }
    log.info('pivotal-to-trello', 'Finished');
  });
}

module.exports = importer;