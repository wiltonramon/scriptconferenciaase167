// ==UserScript==
// @name         ELO | Diagnóstico do alerta undefined
// @namespace    https://cad-elo.tse.jus.br/
// @version      1.0.0
// @description  Registra no console a origem do alerta undefined para diagnóstico.
// @match        https://cad-elo.tse.jus.br/sae/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  // Roda em cada quadro para alcançar também a página aberta depois da consulta.
  const originalAlert = window.alert;
  window.alert = function (message) {
    if (message === undefined || (typeof message === 'string' && message.trim() === 'undefined')) {
      console.error('[ELO ASE diagnóstico] Origem do alerta undefined', {
        quadro: window.name || '(sem nome)',
        carregamento: document.readyState,
        tipoDoArgumento: typeof message,
        pilha: new Error('Rastreamento de alert(undefined)').stack
      });
    }
    // Preserva a mensagem, os argumentos e o comportamento do alerta original.
    return Reflect.apply(originalAlert, window, arguments);
  };
  console.info('[ELO ASE diagnóstico] Ativo neste quadro:', window.name || '(sem nome)');
})();
