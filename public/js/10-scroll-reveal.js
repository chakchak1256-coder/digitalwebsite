// Visual-only scroll reveal animation (IntersectionObserver fade-up). No app logic here.

(function(){
  function markRevealTargets(){
    // Tag visual containers for fade-up reveal; skip anything already tagged.
    var selectors = [
      '#about .about-title','#about .about-desc','#about .about-feat',
      '#about .about-card','.cat-card','.product-card','.purchase-card',
      '#warranty .warranty-title','#warranty .warranty-lead','.warranty-card','.warranty-banner',
      '.feature-strip-item','.trust-item','.bs-row','.testi-card',
      '#contact .contact-form-box','#contact .soc-link','#contact .section-header',
      '.section-header'
    ];
    selectors.forEach(function(sel){
      document.querySelectorAll(sel).forEach(function(el){
        if (!el.classList.contains('dz-reveal') && !el.classList.contains('dz-in')) {
          el.classList.add('dz-reveal');
        }
      });
    });
  }

  function startObserver(){
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.dz-reveal').forEach(function(el){ el.classList.add('dz-in'); });
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting) {
          entry.target.classList.add('dz-in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.dz-reveal').forEach(function(el){ io.observe(el); });
  }

  function init(){
    markRevealTargets();
    startObserver();
    // Re-scan periodically for content rendered asynchronously by the existing
    // app logic (products/categories/testimonials load after fetch calls).
    var rescans = 0;
    var t = setInterval(function(){
      markRevealTargets();
      startObserver();
      rescans++;
      if (rescans > 12) clearInterval(t);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
