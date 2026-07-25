//import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// We want to make some modules globally available, so that our apps/libraries can consume them from there, instead of every app having to bundle its own "react"
// index.html's <head> import map, that grabs the modules when the library tries to import them, and redirects them to our window values

import React from 'react';
import ReactDOM from 'react-dom/client';
import JSXRuntime from 'react/jsx-runtime';
// Expose dependencies to sub-apps
(window as any).React = React;
(window as any).ReactDOM = ReactDOM;
(window as any).ReactJSXRuntime = JSXRuntime;


createRoot(document.getElementById('root')!).render(

    // StrictMode messes up everything. Every app actually gets created twice, because its constructor and componentDidMount methods are called twice, which duplicates all our apps.
  //<StrictMode>
    <App/>
  //</StrictMode>,
)
