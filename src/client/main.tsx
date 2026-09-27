import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

// API and saves always require the live server; the worker only offers an offline notice.
if(import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator){const register=()=>void navigator.serviceWorker.register('/sw.js').catch(()=>undefined);if(document.readyState==='complete')register();else window.addEventListener('load',register,{once:true});}
