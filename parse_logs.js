/**
 * Parser for WordPress Trac Logs
 */
'use strict';

// Option parsing
const ARGS = [
  {
    name: 'start',
    alias: ['to', 'newest'],
    abbr: 't',
    help: 'The most recent changeset (commit) number.'
  },
  {
    name: 'stop',
    alias: ['from', 'oldest'],
    abbr: 'f',
    help: 'The oldest changeset (commit) number.'
  },
  {
    name: 'limit',
    alias: ['max'],
    abbr: 'x',
    'default': 400,
    help: 'The maximum number of changesets to retrieve.'
  },
  {
    name: 'version',
    abbr: 'v',
    help: 'Displays the version information for the script.'
  },
  {
    name: 'debug',
    boolean: true,
    help: 'Displays debugging info while running.'
  }
];
const md = {
  heading: '##',
  subhead: '###',
  line: '------',
  nl: ''
};

// Normally we'd declare constants as UPPERCASE, but not for required modules.
const $ = require('cheerio');
const _ = require('underscore');
const async = require('async');
const request = require('request');
const util = require('util');
const app = require('./package');
const cliOpts = require('cliclopts')(ARGS);
const args = require('minimist')(process.argv.slice(2), cliOpts.options());

var logHTML = '';
var changesets = [];

var startRevision = parseInt(args.start, 10);
var stopRevision = parseInt(args.stop, 10);
var revisionLimit = parseInt(args.max, 10);
var logPath = util.format(
    'https://core.trac.wordpress.org/log?rev=%d&stop_rev=%d&limit=%d&verbose=on',
    startRevision, stopRevision, revisionLimit
);

/**
 * Extend the console object to add .debug().
 *
 * If a console method is called with an added .debug after it,
 * it will only be run if the debug flag is set on the command line.
 *
 * @example console.log('Text') // always prints
 * @example console.log.debug('Text') // only prints if --debug set
 *
 * @returns {Console}
 */
(function consoleDebug() {
  ['info', 'log', 'error', 'warn', 'dir']
      .forEach(function (method) {
        if (typeof method === 'function') {
          console[method].prototype.debug = function () {
            return console[method];
          };
        }
        console[method].debug = args.debug
            ? this.call(console[method], console)
            : function () {
        };
      }, Function.prototype.bind);
})();

console.dir.debug(args, {colors: true});

if (args.help) {
  console.info('Usage: command [options]');
  cliOpts.print();

  console.info('\nExamples:');
  console.info('%s --start 35000 --stop 34800', app.name);
  console.info('%s --from 34800 --to 35000 --max 100', app.name);

  process.exit();
}

if (args.version) {
  console.info('%s v%s', app.name, app.version);
  process.exit();
}

if (isNaN(startRevision) || isNaN(stopRevision) || isNaN(revisionLimit)) {
  console.info('Usage: node parse_logs.js --start=<start_revision> --stop=<revision_to_stop> [--limit=<total_revisions>]\n');
  process.exit();
}

function buildChangesets(buildCallback) {
  console.info('Downloaded. Processing Changesets.');
  console.info('%s\n', md.line);

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
    var propsRegex = /(?:Props:?\s+)(.*)\.?/mi;
    changeset.props = [];

    props = changeset.description.match(propsRegex);
    if (props !== null) {
      console.info.debug('props');
      console.dir.debug(props[1]);

      changeset.props = cleanProps(props[1]);

      console.info.debug(changeset.revision);
      console.dir.debug(changeset.props, {colors: true});
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
  });

  // Collect Props and sort them.
  props = _.uniq(props.sort(function (a, b) {
    return a.toLowerCase().localeCompare(b.toLowerCase());
  }), true);

  propsOutput = util.format('Thanks to @%s, and @%s for their contributions!', _.without(props, _.last(props)).join(', @'), _.last(props));

  // Output!
  console.log('## Code Changes\n\n%s', changesetOutput);
  console.log('## Props\n\n%s', propsOutput);
  outputCallback();
}

/**
 * Takes a string of names from the Props line in a changeset
 * and cleans it up for further use.
 *
 * @param {String} props The list of names from a changeset.
 * @return {Array} The (maybe) cleaned up list of names as an array.
 */
function cleanProps(props) {
  var _props = props
      .replace(/(for.*(,))/ig, '') //for the thing, anothername
      .replace(/(for.*(\.))/, '') //for the thing.
      .replace(/\./gmi, '')
      .trim()
      .replace(/\s/g, ',')
      .split(/\s*,\s*/);

  return _.without(_props, '');
}

async.series([
  function (logCallback) {
    console.info('Downloading from %s', logPath);
    request(logPath, function (err, response, html) {
      if (!err && response.statusCode === 200) {
        logHTML = html;
        logCallback();
      } else {
        return console.error('Error downloading:', err);
      }
    });
  },
  async.apply(buildChangesets),
  async.apply(gatherComponents), // Calls buildOutput() on Finish.
  async.apply(buildOutput)
]);
