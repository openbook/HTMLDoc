var yaml = require("js-yaml");
var _ = require("lodash");
var slug = require("slug");
var request = require("request-sync");
var fs = require("fs");
var path = require("path");

var cwd = process.cwd();

/**
 *
 * @param string content
 * @param string htmldocDom
 * @param string category
 * @param string group
 * @param string fullhtml
 * @returns {Component}
 * @constructor
 */
function Component(content, htmldocDom, category, group, fullHtml) {

  this.content = content;
  this.htmldocDom = htmldocDom;
  this.htmldoc = this.parse(htmldocDom);

  if ( this.type === 'template' ) {
    this.content = fullHtml;
  }

  /*
   * If inline is set, prepend it to the html
   */
  if ( this.inline ) {
    this.content = '<!-- ' + this.inline +  '-->' + this.content;
  }

  this.group = typeof this.group === 'undefined' ? group : this.group;

  this.category = category;

  return this;
}

/**
 * Validate the component
 * @returns {Component}
 */
Component.prototype.validate = function() {
  if ( !this.title ) {
    throw new ComponentError('No title set.', this.content);
  }
  if ( !this.group ) {
    throw new ComponentError('No group set.', this.content);
  }
  return this;
};

/**
 * Parse the block
 * @param body
 * @returns {{}}
 */
Component.prototype.parse = function(body) {

  var htmldoc;
  var value;
  var response;
  var filename;

  body = body.substring(2);

  htmldoc = yaml.load(body);

  /*
   * Defaults
   */
  htmldoc = _.defaults(htmldoc, {
    markup: true,
    external: false,
    type: 'component'
  });

  /*
   * Add to this
   */
  for (var key in htmldoc) {
    value = htmldoc[key];

    /*
     * Load from external source
     */
    if ( typeof value === "string" ) {

      if ( value.substring(0, 7) === 'http://' || value.substring(0, 8) === 'https://' ) {
        response = request(value);

        if ( response.statusCode !== 200) {
          throw new ComponentError('Could not fetch external content from ' + value, this.content);
        }

        value = response.body;
      }
      else if ( value.substring(0, 7) === 'file://') {
        filename = path.resolve(cwd, value.substring(7));

        try {
          response = fs.readFileSync(filename);
        }
        catch ( e ) {

          throw new ComponentError('Could not fetch external content from ' + path.relative(cwd, filename), this.content);
        }

        value = response.toString();
      }
    }

    this[key] = value;
  }

  return htmldoc;
};

/**
 * Get the external filename
 * @returns {string}
 */
Component.prototype.getExternalFilename = function() {
  return this.getFilename({
    suffix: '-external'
  });
};

/**
 * Get the filename of the generated html page
 * @param opts
 * @returns {string}
 */
Component.prototype.getFilename = function() {

  var opts = arguments[0] || {};

  _.defaults(opts, {
    suffix: ''
  });

  return slug(this.category + ' ' + this.group + ' ' + this.title).toLowerCase() + opts.suffix + '.html';
};

/**
 * Component Exception
 *
 * @param message
 * @param htmldocDom
 * @returns {string}
 * @constructor
 */
function ComponentError(message, content) {
  this.name = "ComponentError";
  this.message = "Error: " + message + "\n" + content + "\n";
}

ComponentError.prototype = Error.prototype;
ComponentError.prototype.constructor = ComponentError;

module.exports = Component;