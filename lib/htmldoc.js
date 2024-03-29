/*
 * Core modules
 */
var path = require('path');
var util = require('util');
var cwd = process.cwd();

/*
 * NPM modules
 */
var glob = require("glob");
var fs = require('fs-extra');
var _ = require("lodash");
var cheerio = require("cheerio");
var handlebars = require("handlebars");
var traverse = require('traverse');
var marked = require('marked');
var chalk = require("chalk");
var string = require("string");
var ee = require('event-emitter');
var emitter = ee({});
var async = require('async');
var strftime = require('strftime');
var slug = require('slug');

/*
 * App modules
 */
var git = require('./git.js');
var express = require('./express.js');
var commentComponent = require('./component.js');
var hbsHelpers = require('./handlebar-helpers.js');

/*
 * Config
 */
var packageJson = require('../package.json');


/*
 * Constants
 */
var EOL = require('os').EOL;

/**
 * Get components within the files
 * @param config
 * @returns {*}
 */
var getCommentComponents = function(srcFiles) {

  var components = [];
  var rawHtml;
  var elements;
  var $;
  var deduped;

  srcFiles.forEach(function(categories, i) {

    categories.files.forEach(function(filePattern) {

      files = glob.sync(filePattern);

      files.forEach(function(file) {

        logger.log("Checking " + file, logger.LOG_INFO);

        rawHtml = fs.readFileSync(file, 'utf-8');

        /*
         * For all template comments, we need to ensure it is the only
         * comment on the page so that other components that make up
         * the template aren't replicated on their own pages.
         */
        if (rawHtml.match(/type: template/gm) ) {
          rawHtml = rawHtml.replace(/<!---[\s\S]*?-->/gim, function(match) {
            if ( !match.match(/type: template/gm) ) {
              return '';
            }
            else {
              return match;
            }
          });
        }

        elements = cheerio.parseHTML(rawHtml);
        $ = cheerio.load(rawHtml);

        function descend(elements) {

          _.each(elements, function(elem) {

            var content = '';
            var nextType;

            if ( elem.type == 'comment' && elem.data.substring(0,1) == '-') {

              /*
               * Match sibling element until the sibling changes type
               */

              if ( !$(elem).next().first()[0] ) {
                return false;
              }

              nextType = $(elem).next().first()[0].name;

              $(elem).nextAll().each(function(index, siblingElem) {

                if ( nextType !== siblingElem.name ) {
                  return false;
                }

                content += $(siblingElem).toString();
              });

              var filename = path.basename(file, path.extname(file));

              try {
                logger.log("Found component in " + file, logger.LOG_NOTICE);

                components.push(new commentComponent(
                  content,
                  elem.data,
                  categories.category,
                  string(filename).humanize().s,
                  rawHtml)
                .validate());
              }
              catch ( e ) {
                logger.log(e.toString(), logger.LOG_ERROR);
              }
            }
            return descend(elem.children);
          });
        }

        descend(elements);

      });
    });
  });

  deduped = dedupe(components);

  return deduped;
};

/**
 * We want to combine components with the same title, merging
 * the content.
 */
var dedupe = function(components) {

  var duplicates = [];
  var index;

  var deduped = _.uniq(components, function(item) {
    return item.title + item.group;
  });

  duplicates = _.difference(components, deduped);

  _.each(duplicates, function(item) {

    index = _.findIndex(deduped, function(comp) {
      return comp.group == item.group && comp.title == item.title;
    });

    /*
     * When we find the duplicate, merge the content.
     */
    if ( index >= 0 ) {
      deduped[index].content += EOL + EOL + item.content;
    }

  });

  return deduped;
};

/**
 * Get the navigation object for a category.
 *
 * @param category
 * @returns {Array}
 */
var getNav = function(components, category) {

  var cols = [];

  var ordered = _(components)
    .groupBy(function(item, index) {
      return item.category;
    }).value();

  ordered = _(ordered[category])
    .groupBy(function(item, index) {
      return item.group;
    })
    .map(function(item, index) {
      return {length: item.length, group: index, items: item};
    })
    .sortBy(function(item) {
      return item.length;
    })
    .reverse()
    .value();

//  for ( var i = 0; i<ordered.length; i++ ) {
//    cols[(i%4)] = typeof cols[(i%4)] === 'undefined' ? [] : cols[(i%4)];
//    cols[(i%4)].push(ordered[i]);
//  }
//
//  return cols;

  return ordered;
};

/**
 * Set global data for templates
 * @param config
 * @returns {*}
 */
var setTemplateData = function(components, files, pages) {

  var items;
  var date = new Date();
  var link;
  var currentGroup;
  var templateData = {};

  templateData.nav = [];
  templateData.pages = [];

  _.each(files, function(category) {

    /*
     * Components are currently flat, i.e.
     *
     * {
     *   content: ...
     *   title: ...
     *   type: ...
     * },
     * {
     *   content: ...
     *   title: ...
     *   type: ...
     * }
     *
     */
    items = getNav(components, category.category);

    templateData.nav.push({
      category: category.category,
      items: items
    });
  });

  templateData.global = {
    date: strftime('%d %B %Y')
  };

  pages.forEach(function(page) {
    if ( page.index ) {
      return;
    }
    templateData.pages.push({
      'title': page.title,
      'link': ('page-' + slug(page.title) + '.html').toLowerCase()
    });
  });

  return templateData;

};


/**
 *
 * @param components
 * @returns {*|Array}
 */
var getGroups = function(components, groups) {

  var groupDefault = {};

  var componentsGrouped = _.groupBy(components, function(item, index) {
    return item.category + '-' + item.group;
  });

  var processedGroups = _.map(componentsGrouped, function(item, index) {

    index = item[0].group;

    groups[index] = typeof groups[index] === 'undefined' ? {} : groups[index];

    groupDefault = _.defaults(groups[index], {
      'label': index.charAt(0).toUpperCase() + index.slice(1),
      'id': index,
      'description': ''
    });

    return {
      components: item,
      group: groupDefault,
      category: item[0].category
    };
  });

  return processedGroups;
};


/**
 * Generate component pages
 *
 * @param components
 * @param config
 */
var generateComponentPages = function(components, globalData, config) {

  var templateFile;
  var template;
  var groupTitle;
  var file;
  var templatePath;
  var groups = getGroups(components, config.groups);
  var wrapperTemplate;

  logger.log("Found "+ components.length + " components...", logger.LOG_INFO);

  /*
   * Generate group templates
   */
  _.forEach(groups, function(group, index) {

    _.forEach(group.components, function(component, index) {

      templatePath = path.join(cwd, config.templates + '/pattern.hbs');

      try {
        templateFile = fs.readFileSync(templatePath, 'utf8');
      } catch ( e ) {
        logger.log("Could not find template '" + templatePath + "'", logger.LOG_CRITICAL);
      }

      template = handlebars.compile(templateFile);
      html = template(component);

      /*
       * Register it as a partial
       */
      handlebars.registerPartial("body", html);

      /*
       * Add it to the wrapper
       */

      if ( component.type === 'template' ) {
        //wrapperTemplate = 'wrapper-external.hbs';
        wrapperTemplate = 'wrapper.hbs';
      }
      else {
        wrapperTemplate = 'wrapper.hbs';
      }

      templatePath = path.join(cwd, config.templates, wrapperTemplate);

      try {
        templateFile = fs.readFileSync(templatePath, 'utf8');
      } catch (e) {
        logger.log("Could not find template '" + templatePath, logger.LOG_CRITICAL);
      }

      template = handlebars.compile(templateFile);

      var file = path.join(cwd, config.publish, component.getFilename());

      var content = component.type === 'component' ? globalData : component;

      fs.outputFileSync(file, template( globalData));

      logger.log("Generated " + path.relative(cwd, file), logger.LOG_SUCCESS);

      /*
       * This is about as DRY as a puddle
       */
      if ( component.external ) {

        /*
         * Generate the bare file as well
         */
        wrapperTemplate = 'wrapper-external.hbs';

        templatePath = path.join(cwd, config.templates, wrapperTemplate);

        try {
          templateFile = fs.readFileSync(templatePath, 'utf8');
        } catch (e) {
          logger.log("Could not find template '" + templatePath, logger.LOG_CRITICAL);
        }

        template = handlebars.compile(templateFile);

        file = path.join(cwd, config.publish, component.getExternalFilename());

        fs.outputFileSync(file, template(component));

        logger.log("Generated " + path.relative(cwd, file), logger.LOG_SUCCESS);
      }
    });
  });

  /*
   * Copy wrapper ui
   */
  fs.copySync(path.join(cwd, config.templates, config.template_assets), path.join(cwd, config.publish, config.template_assets));

  /*
   * Copy project ui
   */
  _.each(config.assets, function(asset) {
    fs.copySync(path.join(cwd, asset), path.join(cwd, config.publish, asset));
  });

};


/**
 * Generate page pages
 *
 * @param config
 */
var generateStaticPages = function(globalData, config) {

  var templateFile;
  var template;
  var content;
  var html;
  var file;

  if ( !config.pages ) {
    return this;
  }

  config.pages.forEach(function(page) {

    if ( typeof page.src === 'undefined' ) {
      return;
    }

    /*
     * Get the content of the file
     */
    content = fs.readFileSync(path.join(cwd, page.src), 'utf8');

    /*
     * Get the page template
     */
    templatePath = path.join(cwd, config.templates + '/page.hbs');
    try {
      templateFile = fs.readFileSync(templatePath, 'utf8');
    } catch (e) {
      logger.log("Could not find template '" + templatePath + "'", logger.LOG_CRITICAL);
    }

    template = handlebars.compile(templateFile);
    html = template({
      content: marked(content)
    });

    handlebars.registerPartial("body", html);
    templateFile = fs.readFileSync(path.join(cwd, config.templates + '/wrapper.hbs'), 'utf8');
    template = handlebars.compile(templateFile);

    if ( page.index ) {
      file = path.join(cwd, config.publish, 'index.html').toLowerCase();
    }
    else {
      file = path.join(cwd, config.publish, 'page-' + slug(page.title) + '.html').toLowerCase();
    }

    fs.outputFileSync(file, template(globalData));
  });

};

/**
 *
 * @param _config
 * @param _logger
 */
var generate = function(config, _logger) {

  var components;

  config = _.defaults(config, {
    use_groups: true,
    publish: 'publish',
    use_git: false,
    preview: false,
    port: 3000,
    groups: {}
  });

  logger = _logger;

  /*
   * Register handlebar helpers
   */
  hbsHelpers(config);

  fs.removeSync(config.publish);

  components = getCommentComponents(config.files);

  var templateData = setTemplateData(components, config.files, config.pages);
  generateComponentPages(components, templateData, config);
  generateStaticPages(templateData, config);

  if ( config.use_git ) {
    git(emitter, logger);
  }

  if ( config.preview ) {
    express(emitter, logger);
  }

  emitter.emit('complete', config);
};


/*
 * Expose an API
 */
module.exports = {
  generate: generate,
  generateComponents: generateComponentPages,
  generatePages: generateStaticPages
};