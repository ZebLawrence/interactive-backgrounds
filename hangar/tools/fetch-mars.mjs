// Downloads the USGS Viking colour mosaic of Mars (public domain) into hangar/tools/raw/images/ and records it
// in the manifest. Run prepare-images.sh afterwards to make the 8K browser copy.
//
//   node hangar/tools/fetch-mars.mjs
//
// The full 232 m/px GeoTIFF is 12.7 GB, so this takes USGS's own 1 km/px JPEG of the same mosaic (37 MB,
// about 21,000 x 10,600 px, equirectangular, 180 W at the left edge), which is still well above 8K.
import path from 'node:path';
import { RAW, readManifest, writeManifest, download } from './manifest-lib.mjs';

const URL_1KM = 'https://astrogeology.usgs.gov/ckan/dataset/7131d503-cdc9-45a5-8f83-5126c0fd397e/resource/5ea881c6-01b3-41fa-a7af-42d2131b54f1/download/mars_viking_mdim21_clrmosaic_1km.jpg';
const PAGE = 'https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m';

await download(URL_1KM, path.join(RAW, 'images', 'mars', 'mars_viking_mdim21_clrmosaic_1km.jpg'));
const m = readManifest();
m.images.mars = {
  file: 'assets/images/mars.ktx2',
  name: 'Mars Viking MDIM2.1 Colorized Global Mosaic (1 km/px release), resampled to 8192 x 4096',
  source: PAGE,
  download: URL_1KM,
  author: 'NASA / JPL / USGS Astrogeology Science Center',
  license: 'PD',
};
writeManifest(m);
console.log(`images.mars <- ${URL_1KM}`);
