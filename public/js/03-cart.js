// Cart drawer: toggle, render, quantity changes, badge count.

// ===== CART =====
function toggleCart() {
  const ov = document.getElementById('cart-overlay');
  const dr = document.getElementById('cart-drawer');
  ov.classList.toggle('open'); dr.classList.toggle('open');
  if (dr.classList.contains('open')) { renderCartItems(); document.body.classList.add('no-scroll'); }
  else document.body.classList.remove('no-scroll');
}

function renderCartItems() {
  const validIds = new Set(DB.getAll('products').map(p => p.id));
  if (validIds.size) Cart.prune(validIds); // drop items for products the seller has since removed
  const items = Cart.get(); const s = Settings.get();
  const body = document.getElementById('cart-body');
  const foot = document.getElementById('cart-foot');
  if (!items.length) {
    body.innerHTML = `<div class="cart-empty"><i class="fa-solid fa-bag-shopping"></i><p>Your cart is empty</p><button class="btn btn-primary" style="margin-top:.5rem" onclick="toggleCart();document.getElementById('products').scrollIntoView({behavior:'smooth'})">Browse Products</button></div>`;
    foot.style.display = 'none'; return;
  }
  foot.style.display = 'block'; body.innerHTML = '';
  items.forEach(item => {
    const d = document.createElement('div'); d.className = 'cart-item';
    const img = item.img || generatePlaceholder(item.name, 60, 60);
    d.innerHTML = `
      <div class="cart-item-img"><img src="${img}" alt=""/></div>
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name}</div>
        <div class="cart-item-price">${formatPrice(item.price*item.qty, s.currency)}</div>
        <div class="cart-item-row">
          <button class="qty-btn" onclick="changeQty('${item.id}',-1)"><i class="fa-solid fa-minus"></i></button>
          <span class="qty-num">${item.qty}</span>
          <button class="qty-btn" onclick="changeQty('${item.id}',1)"><i class="fa-solid fa-plus"></i></button>
          <button class="cart-del" onclick="removeItem('${item.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
    body.appendChild(d);
  });
  document.getElementById('cart-total-val').textContent = Cart.total().toLocaleString() + ' ' + s.currency;
}

function changeQty(id, d) { Cart.setQty(id, (Cart.get().find(i=>i.id===id)?.qty||1)+d); renderCartItems(); }
function removeItem(id) { Cart.remove(id); renderCartItems(); }
function updateCartBadge() { const c=Cart.count(); const b=document.getElementById('cart-badge'); b.textContent=c; b.style.display=c?'flex':'none'; }

