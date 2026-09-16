'use strict';

// Builder entry. The whole plugin is the onAfterBuild hook in ./hooks.js — no build-panel
// options, no custom panel: every network runs off the same build and the CTA is probed at
// runtime by `playable-ads-core`, so there is nothing for the user to pick.

exports.load = () => {};
exports.unload = () => {};

exports.configs = {
    'web-mobile': {
        hooks: './hooks'
    }
};
