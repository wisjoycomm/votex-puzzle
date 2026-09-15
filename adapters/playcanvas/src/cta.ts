// This game's store links. Detection and dispatch live in `playable-ads-core`.
// Meta and Google ignore these; MRAID and the no-network fallback do not.

import { openStore as open } from 'playable-ads-core';
import type { StoreUrls } from 'playable-ads-core';

const STORE_URLS: StoreUrls = {
    ios: 'https://apps.apple.com/app/idXXXXXXXXXX',
    android: 'https://play.google.com/store/apps/details?id=com.votex.beecube'
};

export function openStore(): void {
    open(STORE_URLS);
}
