define([
    "jquery",
    "underscore",
    "utils",
    "settings",
    "eventMgr",
    "fileSystem",
    "fileMgr",
    "sharing",
    "classes/Provider",
    "providers/bloggerProvider",
    "providers/dropboxProvider",
    "providers/gistProvider",
    "providers/githubProvider",
    "providers/gdriveProvider",
    "providers/sshProvider",
    "providers/tumblrProvider",
    "providers/wordpressProvider"
], function($, _, utils, settings, eventMgr, fileSystem, fileMgr, sharing, Provider) {

    var publisher = {};

    // Create a map with providerId: providerModule
    var providerMap = _.chain(arguments).map(function(argument) {
        return argument instanceof Provider && [
            argument.providerId,
            argument
        ];
    }).compact().object().value();

    // Retrieve publish locations from localStorage
    _.each(fileSystem, function(fileDesc) {
        _.each(utils.retrieveIndexArray(fileDesc.fileIndex + ".publish"), function(publishIndex) {
            try {
                var publishAttributes = JSON.parse(localStorage[publishIndex]);
                // Store publishIndex
                publishAttributes.publishIndex = publishIndex;
                // Replace provider ID by provider module in attributes
                var provider = providerMap[publishAttributes.provider];
                if(!provider) {
                    throw new Error("Invalid provider ID: " + publishAttributes.provider);
                }
                publishAttributes.provider = provider;
                fileDesc.publishLocations[publishIndex] = publishAttributes;
            }
            catch(e) {
                // localStorage can be corrupted
                eventMgr.onError(e);
                // Remove publish location
                utils.removeIndexFromArray(fileDesc.fileIndex + ".publish", publishIndex);
                localStorage.removeItem(publishIndex);
            }
        });
    });

    // Apply template to the current document
    publisher.applyTemplate = function(fileDesc, publishAttributes, html) {
        try {
            var template = (publishAttributes && publishAttributes.customTmpl) || settings.template;
            return _.template(template, {
                documentTitle: fileDesc.title,
                documentMarkdown: fileDesc.content,
                documentHTML: html,
                publishAttributes: publishAttributes
            });
        }
        catch(e) {
            eventMgr.onError(e);
            return e.message;
        }
    };

    // Used to get content to publish
    function getPublishContent(fileDesc, publishAttributes, html) {
        if(publishAttributes.format === undefined) {
            publishAttributes.format = utils.getInputRadio("radio-publish-format");
            if(publishAttributes.format == 'template' && utils.getInputChecked("#checkbox-publish-custom-template")) {
                publishAttributes.customTmpl = utils.getInputValue('#textarea-publish-custom-template');
            }
        }
        if(publishAttributes.format == "markdown") {
            return fileDesc.content;
        }
        else if(publishAttributes.format == "html") {
            return html;
        }
        else {
            return publisher.applyTemplate(fileDesc, publishAttributes, html);
        }
    }

    // Recursive function to publish a file on multiple locations
    var publishAttributesList = [];
    var publishFileDesc = undefined;
    var publishHTML = undefined;
    function publishLocation(callback, errorFlag) {

        // No more publish location for this document
        if(publishAttributesList.length === 0) {
            callback(errorFlag);
            return;
        }

        // Dequeue a synchronized location
        var publishAttributes = publishAttributesList.pop();

        // Format the content
        var content = getPublishContent(publishFileDesc, publishAttributes, publishHTML);

        // Call the provider
        publishAttributes.provider.publish(publishAttributes, publishFileDesc.title, content, function(error) {
            if(error !== undefined) {
                var errorMsg = error.toString();
                if(errorMsg.indexOf("|removePublish") !== -1) {
                    publishFileDesc.removePublishLocation(publishAttributes);
                    eventMgr.onPublishRemoved(publishFileDesc, publishAttributes);
                }
                if(errorMsg.indexOf("|stopPublish") !== -1) {
                    callback(error);
                    return;
                }
            }
            publishLocation(callback, errorFlag || error);
        });
    }

    // Get the html from the onPreviewFinished callback
    var previewHtml = undefined;
    eventMgr.addListener("onPreviewFinished", function(html) {
        previewHtml = html;
    });

    // Listen to offline status changes
    var isOffline = false;
    eventMgr.addListener("onOfflineChanged", function(isOfflineParam) {
        isOffline = isOfflineParam;
    });

    var publishRunning = false;
    publisher.publish = function() {
        // If publish is running or offline
        if(publishRunning === true || isOffline === true) {
            return;
        }

        publishRunning = true;
        eventMgr.onPublishRunning(true);
        publishFileDesc = fileMgr.currentFile;
        publishHTML = previewHtml;
        publishAttributesList = _.values(publishFileDesc.publishLocations);
        publishLocation(function(errorFlag) {
            publishRunning = false;
            eventMgr.onPublishRunning(false);
            if(errorFlag === undefined) {
                eventMgr.onPublishSuccess(publishFileDesc);
            }
        });
    };

    // Generate a publishIndex associated to a file and store publishAttributes
    function createPublishIndex(fileDesc, publishAttributes) {
        var publishIndex = undefined;
        do {
            publishIndex = "publish." + utils.randomString();
        } while (_.has(localStorage, publishIndex));
        publishAttributes.publishIndex = publishIndex;
        fileDesc.addPublishLocation(publishAttributes);
        eventMgr.onNewPublishSuccess(fileDesc, publishAttributes);
    }

    // Initialize the "New publication" dialog
    var newLocationProvider = undefined;
    function initNewLocation(provider) {
        var defaultPublishFormat = provider.defaultPublishFormat || "markdown";
        newLocationProvider = provider;
        $(".publish-provider-name").text(provider.providerName);

        // Show/hide controls depending on provider
        $('div[class*=" modal-publish-"]').hide().filter(".modal-publish-" + provider.providerId).show();

        // Reset fields
        utils.resetModalInputs();
        utils.setInputRadio("radio-publish-format", defaultPublishFormat);
        utils.setInputChecked("#checkbox-publish-custom-template", false);
        utils.setInputValue('#textarea-publish-custom-template', settings.template);

        // Load preferences
        var publishPreferences = utils.retrieveIgnoreError(provider.providerId + ".publishPreferences");
        if(publishPreferences) {
            _.each(provider.publishPreferencesInputIds, function(inputId) {
                utils.setInputValue("#input-publish-" + inputId, publishPreferences[inputId]);
            });
            utils.setInputRadio("radio-publish-format", publishPreferences.format);
            utils.setInputChecked("#checkbox-publish-custom-template-toggle", publishPreferences.customTmpl !== undefined);
            utils.setInputValue('#checkbox-publish-custom-template', publishPreferences.customTmpl || settings.template);
        }

        // Open dialog box
        $(".modal-publish").modal();
    }

    // Add a new publish location to a local document
    function performNewLocation(event) {
        var provider = newLocationProvider;
        var publishAttributes = provider.newPublishAttributes(event);
        if(publishAttributes === undefined) {
            return;
        }

        // Perform provider's publishing
        var fileDesc = fileMgr.currentFile;
        var html = previewHtml;
        var content = getPublishContent(fileDesc, publishAttributes, html);
        provider.publish(publishAttributes, fileDesc.title, content, function(error) {
            if(error === undefined) {
                publishAttributes.provider = provider;
                sharing.createLink(publishAttributes, function() {
                    createPublishIndex(fileDesc, publishAttributes);
                });
            }
        });

        // Store input values as preferences for next time we open the publish
        // dialog
        var publishPreferences = {};
        _.each(provider.publishPreferencesInputIds, function(inputId) {
            publishPreferences[inputId] = document.getElementById("input-publish-" + inputId).value;
        });
        publishPreferences.format = publishAttributes.format;
        publishPreferences.customTmpl = publishAttributes.customTmpl;
        localStorage[provider.providerId + ".publishPreferences"] = JSON.stringify(publishPreferences);
    }

    var initPublishButtonTmpl = [
        '<li>',
        '   <a href="#"',
        '    class="action-init-publish-<%= provider.providerId %>">',
        '       <i class="icon-provider-<%= provider.providerId %>"></i> <%= provider.providerName %>',
        '   </a>',
        '</li>'
    ].join('');
    eventMgr.addListener("onReady", function() {
        if(viewerMode === false) {
            // Add every provider in the panel menu
            var publishMenuElt = document.querySelector('.menu-panel .collapse-publish-on .nav');
            var publishMenuHtml = _.reduce(providerMap, function(result, provider) {
                return result + _.template(initPublishButtonTmpl, {
                    provider: provider
                });
            }, '');
            publishMenuElt.innerHTML = publishMenuHtml;
            _.each(providerMap, function(provider) {
                // Click on open publish dialog
                $(publishMenuElt.querySelector('.action-init-publish-' + provider.providerId)).click(function() {
                    initNewLocation(provider);
                });
                // Click on perform new publication
                $(".action-publish-" + provider.providerId).click(function() {
                    initNewLocation(provider);
                });
            });
        }
        
        // 
        $(".action-process-publish").click(performNewLocation);
        
        var $customTmplCollapseElt = $('.publish-custom-template-collapse').collapse();
        var $customTmplTextareaElt = $('#textarea-publish-custom-template');
        $("#checkbox-publish-custom-template").change(function() {
            $customTmplTextareaElt.prop('disabled', !this.checked);
        });
        $("input:radio[name=radio-publish-format]").change(function() {
            $customTmplCollapseElt.collapse(this.value == 'template' ? 'show' : 'hide');
        });
        

        // Save As menu items
        $(".action-download-md").click(function() {
            var content = document.getElementById("wmd-input").value;
            var title = fileMgr.currentFile.title;
            utils.saveAs(content, title + ".md");
        });
        $(".action-download-html").click(function() {
            var title = fileMgr.currentFile.title;
            utils.saveAs(previewHtml, title + ".html");
        });
        $(".action-download-pdf").click(function() {
            var title = fileMgr.currentFile.title;
            utils.saveAsPdf(previewHtml, title + ".pdf");
        });
        $(".action-download-template").click(function() {
            var fileDesc = fileMgr.currentFile;
            var content = publisher.applyTemplate(fileDesc, undefined, previewHtml);
            utils.saveAs(content, fileDesc.title + (settings.template.indexOf("documentHTML") === -1 ? ".md" : ".html"));
        });
    });

    eventMgr.onPublisherCreated(publisher);
    return publisher;
});