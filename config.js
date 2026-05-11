// Deployment mode — change this one value to switch between environments.
//
//   'serverless'  uses .gz files + DecompressionStream in the worker.
//                 Works on GitHub Pages, Netlify, Vercel, any CDN.
//                 No server needed. Run: python3 -m http.server 8080
//
//   'server'      uses .br files served via Content-Encoding: br header.
//                 Requires: node server.js
//                 Smaller payload (~750KB vs ~950KB) but needs Node.

const CONFIG = {
  mode: 'serverless'
};
