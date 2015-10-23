/**
 * Parser for WordPress Trac Logs
 */
'use strict';

var $ = require('cheerio');
var _ = require('underscore');
var parseArgs = require('minimist');
var async = require('async');
var request = require('request');
var util = require('util');

function buildChangesets(buildCallback) {
  console.log('Downloaded. Processing Changesets.');

  var logEntries = $.load(logHTML)('tr.verbose');

  // Each Changeset has two Rows. We Parse them both at once.
  for (var i = 0; i < logEntries.length; i += 2) {
    var changeset = {};
    var props;
    var description;
    var related;

    if (logEntries[i + 1] == null) {
      break;
    }

    changeset.revision = $(logEntries[i]).find('td.rev').text().trim().replace(/@(.*)/, '[$1]');
    changeset.author = $(logEntries[i]).find('td.author').text().trim();

    description = $(logEntries[i + 1]).find('td.log');

    // Re-add `` for code segments.
    $(description).find('tt').each(function () {
      $(this).replaceWith('`' + $(this).text() + '`');
    });

    // Store "Fixes" or "See" tickets.
    changeset.related = [];
    changeset.component = [];
    $(description).find('a.ticket').each(function () {
      var ticket = $(this).text().trim().replace(/#(.*)/, '$1');
      changeset.related.push(ticket);
    });

    // Create base description
    changeset.description = description.text();

    // For now, get rid of Fixes and See notes. Should we annotate in summary?
    changeset.description = changeset.description.replace(/[\n|, ]Fixes(.*)/i, '');
    changeset.description = changeset.description.replace(/\nSee(.*)/i, '');

    // Extract Props
    var propsRegex = /\nProps(.*)./i;
    changeset.props = [];

    props = changeset.description.match(propsRegex);
    if (props !== null) {
      changeset.props = props[1].trim().split(/\s*,\s*/);
    }

    // Remove Props
    changeset.description = changeset.description.replace(propsRegex, '');

    // Limit to 2 consecutive carriage returns
    changeset.description = changeset.description.replace(/\n\n\n+/g, '\n\n');
    changeset.description = changeset.description.trim();

    changesets.push(changeset);
  }
  buildCallback();
}

function gatherComponents(gatherCallback) {
  var component = '';
  var ticketPath = 'https://core.trac.wordpress.org/ticket/';

  async.each(changesets, function (changeset, changesetCallback) {
        async.each(changeset.related, function (ticket, relatedCallback) {
          request(ticketPath + ticket, function (err, response, body) {
            if (!err && response.statusCode === 200) {
              component = $.load(body)('#h_component').next('td').text().trim();
              changeset.component.push(component);
            }
            relatedCallback();
          });
        }, function (err) {
          if (!err) {
            // TODO: Pick best category for this changeset.
            changesetCallback();
          } else {
            console.error('ERROR: %s', err);
          }
        });
      },
      function (err) {
        if (!err) {
          gatherCallback();
          //buildOutput();
        } else {
          console.error('ERROR: %s', err);
        }
      });
}

function buildOutput(outputCallback) {
  // Reconstitute Log and Collect Props
  var propsOutput;
  var changesetOutput = '';
  var props = [];
  var categories = {};
  var category = '';

  async.map(changesets,
      function (item) {
        category = item.component;

        if (!category) {
          category = 'Misc';
        }

        if (!categories[category]) {
          categories[category] = [];
        }

        categories[item.component].push(item);
      }
  );

  _.each(categories, function (category) {
    changesetOutput += "### " + category[0].component + "\n";
    _.each(category, function (changeset) {

      changesetOutput += '* ' +
          changeset.description.trim() + ' ' +
          changeset.revision + ' ' +
          '#' + changeset.related.join(', #') + "\n";

      // Make sure Committers get credit
      props.push(changeset.author);

      // Sometimes Committers write their own code.
      // When this happens, there are no additional props.
      if (changeset.props.length !== 0) {
        props = props.concat(changeset.props);
      }

    });

    changesetOutput += "\n";
  });

  // Collect Props and sort them.
  props = _.uniq(props.sort(function (a, b) {
    return a.toLowerCase().localeCompare(b.toLowerCase());
  }), true);

  propsOutput = util.format('Thanks to @%s, and @%s for their contributions!', _.without(props, _.last(props)).join(', @'), _.last(props));

  // Output!
  console.log(changesetOutput + "\n\n" + propsOutput);
  outputCallback();
}

var logPath;
var logHTML;
var changesets = [];
var args = parseArgs(process.argv.slice(2), {
  'alias': {
    'start': ['to'],
    'stop': ['from']
  },
  'default': {
    'limit': 400
  }
});
var startRevision = parseInt(args.start, 10);
var stopRevision = parseInt(args.stop, 10);
var revisionLimit = parseInt(args.limit, 10);

if (isNaN(startRevision) || isNaN(stopRevision)) {
  console.info("Usage: node parse_logs.js --start=<start_revision> --stop=<revision_to_stop> [--limit=<total_revisions>]\n");
  return;
}

logPath = util.format(
    'https://core.trac.wordpress.org/log?rev=%d&stop_rev=%d&limit=%d&verbose=on',
    startRevision, stopRevision, revisionLimit
);

async.series([
  function (logCallback) {
    console.log('Downloading %s', logPath);
    request(logPath, function (err, response, html) {
      if (!err && response.statusCode === 200) {
        logHTML = html;
        logCallback();
      } else {
        console.error('Error downloading %s.', logPath);
        return err;
      }
    });
  },
  async.apply(buildChangesets),
  async.apply(gatherComponents), // Calls buildOutput() on Finish.
  async.apply(buildOutput)
]);
