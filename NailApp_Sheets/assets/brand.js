/**
 * Nail Studio Pro — ícones de categoria e miniaturas (desenhados no Figma:
 * "Nail Studio Pro — Ícones e Miniaturas", fonte vetorial em design/icons.js).
 */
(function () {
  var BASE = 'assets/';
  var KEYS = ['alongamentos', 'blindagem', 'nailart', 'spa', 'manicure', 'geral'];
  var RULES = [
    ['alongamentos', /along|fibra|acril|molde|tips?\b|postic/],
    ['blindagem', /blind|gel|banho|fortalec|polygel/],
    ['nailart', /art|decor|desenh|encapsul|francesinha|pedraria|adesivo/],
    ['spa', /spa|hidrat|parafina|esfolia|massag|relax/],
    ['manicure', /manicure|pedicure|\bmaos?\b|\bpes?\b|esmalt|cuticul|unha/]
  ];
  // Fotos genéricas antigas (Unsplash) do catálogo inicial: trocadas pelas miniaturas novas
  var STOCK = /images\.unsplash\.com\/photo-(1604654894610|1519014816548|1632345031435|1522337360788)/;

  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function categoryKey() {
    var text = norm(Array.prototype.join.call(arguments, ' '));
    for (var i = 0; i < RULES.length; i++) if (RULES[i][1].test(text)) return RULES[i][0];
    return 'geral';
  }

  function thumbFor(categoria, nome) { return BASE + 'thumbs/' + categoryKey(categoria, nome) + '.jpg'; }
  function iconFor(categoria) { return BASE + 'icons/cat-' + categoryKey(categoria) + '.svg'; }

  /** Foto do serviço: a enviada pela manicure ou a miniatura da categoria. */
  function servicePhoto(s) {
    var url = s && s.fotoUrl ? String(s.fotoUrl) : '';
    if (!url || STOCK.test(url)) return thumbFor(s && s.categoria, s && s.nome);
    return url;
  }

  /** Atributo onerror seguro para <img>: cai na miniatura da categoria. */
  function fallbackAttr(categoria, nome) {
    return "this.onerror=null;this.src='" + thumbFor(categoria, nome) + "'";
  }

  /** HTML do ícone de categoria (img com tamanho em px). */
  function iconHtml(categoria, size) {
    var px = size || 20;
    return '<img src="' + iconFor(categoria) + '" alt="" width="' + px + '" height="' + px +
      '" style="width:' + px + 'px;height:' + px + 'px;border-radius:' + Math.round(px * 0.29) + 'px;flex-shrink:0;vertical-align:middle;">';
  }

  window.NailBrand = { KEYS: KEYS, categoryKey: categoryKey, thumbFor: thumbFor, iconFor: iconFor, servicePhoto: servicePhoto, fallbackAttr: fallbackAttr, iconHtml: iconHtml };
})();
