import { Actor } from 'apify';

import {  PlaywrightCrawler, Dataset,log } from "crawlee";
import { router } from "./route.js";

await Actor.init();
log.setLevel(log.LEVELS.DEBUG);

log.debug('Setting up crawler.');

const crawlee = new  PlaywrightCrawler({
    requestHandler: router
})

await crawlee.run(['https://warehouse-theme-metal.myshopify.com/collections'])

await Actor.exit();