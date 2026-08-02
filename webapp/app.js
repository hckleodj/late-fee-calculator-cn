'use strict';

(() => {
  const config = window.DAJIN_WEB_CONFIG || {};
  const domain = window.DajinDomain;
  const state = {
    token: sessionStorage.getItem('dajinWebSession') || '',
    route: 'dashboard',
    customerId: '',
    detail: null,
    cache: new Map()
  };

  const $ = id => document.getElementById(id);
  const view = $('view');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function money(cents) {
    return (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function todayKey() {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function showNotice(message, isError = false) {
    const node = $('notice');
    node.textContent = message;
    node.classList.toggle('error', isError);
    node.hidden = !message;
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? label : button.dataset.label || button.textContent;
  }

  async function apiCall(action, payload = {}, options = {}) {
    if (!config.apiUrl) throw new Error('尚未配置 CloudBase 网页API地址。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
    let response;
    try {
      response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(state.token ? { authorization: `Bearer ${state.token}` } : {})
        },
        body: JSON.stringify({ action, payload }),
        cache: 'no-store',
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('云端响应超时，请检查网络后重试。已完成的数据不会重复导入。');
      throw new Error('暂时无法连接云端，请检查网络后重试。');
    } finally {
      clearTimeout(timeout);
    }
    let result;
    try { result = await response.json(); }
    catch (_error) { throw new Error('云端返回了无法识别的内容。'); }
    if (!response.ok || !result.ok) {
      if (response.status === 401 && action !== 'web.auth.login') logout(true);
      const error = new Error(result.error && result.error.message || '云端请求失败。');
      error.code = result.error && result.error.code;
      error.details = result.error && result.error.details;
      throw error;
    }
    return result.data;
  }

  async function cachedApiCall(action, payload = {}, options = {}) {
    const key = `${action}:${JSON.stringify(payload)}`;
    const cached = state.cache.get(key);
    const maxAgeMs = options.maxAgeMs || 15000;
    if (!options.force && cached && Date.now() - cached.savedAt < maxAgeMs) return cached.data;
    const data = await apiCall(action, payload, options);
    state.cache.set(key, { data, savedAt: Date.now() });
    return data;
  }

  function clearBusinessCache() {
    state.cache.clear();
  }

  function showApp(loggedIn) {
    $('login-view').hidden = loggedIn;
    $('app-shell').hidden = !loggedIn;
    $('logout-button').hidden = !loggedIn;
  }

  async function login(event) {
    event.preventDefault();
    const button = event.submitter;
    $('login-error').textContent = '';
    setBusy(button, true, '登录中…');
    try {
      const result = await apiCall('web.auth.login', { password: $('login-password').value });
      state.token = result.token;
      sessionStorage.setItem('dajinWebSession', state.token);
      $('login-password').value = '';
      showApp(true);
      await navigate('dashboard');
    } catch (error) {
      $('login-error').textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  }

  function logout(render = true) {
    state.token = '';
    state.customerId = '';
    clearBusinessCache();
    sessionStorage.removeItem('dajinWebSession');
    if (render) {
      showApp(false);
      $('login-error').textContent = '';
    }
  }

  function loading() {
    view.replaceChildren($('loading-template').content.cloneNode(true));
  }

  function bindRouteButtons() {
    document.querySelectorAll('[data-route]').forEach(button => {
      button.classList.toggle('active', button.dataset.route === state.route);
      button.onclick = () => navigate(button.dataset.route);
    });
  }

  async function navigate(route, options = {}) {
    state.route = route;
    state.customerId = options.customerId || state.customerId;
    showNotice('');
    bindRouteButtons();
    if (route === 'calculator') return renderCalculator();
    loading();
    try {
      if (route === 'dashboard') await renderDashboard(options);
      else if (route === 'customers') await renderCustomers(options);
      else if (route === 'customer') await renderCustomerDetail(state.customerId, options);
      else if (route === 'settings') await renderSettings();
    } catch (error) {
      view.innerHTML = `<section class="panel"><h2>操作未完成</h2><p class="error">${escapeHtml(error.message)}</p><button type="button" id="retry-view">重试</button></section>`;
      $('retry-view').onclick = () => navigate(route, options);
    }
  }

  function groupOverdue(items) {
    const groups = new Map();
    items.forEach(item => {
      const key = item.customerId;
      if (!groups.has(key)) groups.set(key, { customerId: key, customer: item.customer, items: [], contract: 0, fee: 0, maxDays: 0 });
      const group = groups.get(key);
      group.items.push(item);
      group.contract += item.remainingContractCents;
      group.fee += item.lateFeeCents;
      group.maxDays = Math.max(group.maxDays, item.daysOverdue);
    });
    return [...groups.values()].sort((a, b) => b.maxDays - a.maxDays);
  }

  function reminderRows(items, type) {
    if (!items.length) return '<p class="empty">当前没有记录。</p>';
    return `<div class="list">${items.map(item => `<button type="button" class="list-item ${type}" data-customer="${escapeHtml(item.customerId)}">
      <span><h3>${escapeHtml(item.customer && item.customer.name || '未命名客户')}</h3><p>${escapeHtml(item.customer && item.customer.plate || '')} · 第${item.termNo}期 · ${escapeHtml(item.dueDateKey)}${item.daysOverdue ? ` · 逾期${item.daysOverdue}天` : ''}</p></span>
      <span class="amount">${money(item.remainingContractCents)}元${item.lateFeeCents ? `<br><small>滞纳金 ${money(item.lateFeeCents)}元</small>` : ''}</span>
    </button>`).join('')}</div>`;
  }

  async function renderDashboard(options = {}) {
    const data = await cachedApiCall('dashboard.list', { todayDateKey: todayKey() }, { force: options.force, maxAgeMs: 15000 });
    const overdueGroups = groupOverdue(data.overdue);
    view.innerHTML = `<section class="panel">
      <div class="section-title"><div><h2>还款提醒</h2><span class="muted">${todayKey()}</span></div><button type="button" class="secondary" id="refresh-dashboard">刷新</button></div>
      <div class="grid three" style="margin-top:16px">
        <div class="metric"><span>今日应还</span><strong>${data.today.length}</strong></div>
        <div class="metric"><span>未来3天</span><strong>${data.upcoming.length}</strong></div>
        <div class="metric overdue"><span>已逾期客户</span><strong>${overdueGroups.length}</strong></div>
      </div>
    </section>
    <section class="panel"><h2>今日应还</h2>${reminderRows(data.today, '')}</section>
    <section class="panel"><h2>未来3天到期</h2>${reminderRows(data.upcoming, '')}</section>
    <section class="panel"><h2>已逾期</h2>${overdueGroups.length ? `<div class="list">${overdueGroups.map(group => `<button type="button" class="list-item overdue" data-customer="${escapeHtml(group.customerId)}"><span><h3>${escapeHtml(group.customer && group.customer.name || '未命名客户')}</h3><p>${group.items.length}期逾期 · 最长${group.maxDays}天</p></span><span class="amount">应付 ${money(group.contract + group.fee)}元<br><small>含滞纳金 ${money(group.fee)}元</small></span></button>`).join('')}</div>` : '<p class="empty">当前没有逾期客户。</p>'}</section>`;
    $('refresh-dashboard').onclick = () => navigate('dashboard', { force: true });
    view.querySelectorAll('[data-customer]').forEach(button => button.onclick = () => navigate('customer', { customerId: button.dataset.customer }));
  }

  function calculateQuote(form) {
    const price = domain.yuanToCents(form.get('vehiclePrice'));
    const rate = domain.percentToBps(form.get('monthlyRate'));
    const terms = Number(form.get('terms'));
    const method = form.get('interestMethod');
    let loan, down, payment;
    if (form.get('mode') === 'reverse') {
      payment = domain.yuanToCents(form.get('targetPayment'));
      loan = Math.min(price, domain.principalFromPaymentCents(payment, rate, terms, method));
      down = price - loan;
      payment = domain.calculateMonthlyPaymentCents(loan, rate, terms, method);
    } else {
      down = Math.round(price * domain.percentToBps(form.get('downPaymentRate')) / 10000);
      loan = price - down;
      payment = domain.calculateMonthlyPaymentCents(loan, rate, terms, method);
    }
    const schedule = domain.buildRepaymentSchedule({ principalCents: loan, monthlyRateBps: rate, terms, interestMethod: method, startDateKey: todayKey(), dueDay: 1 });
    return { price, loan, down, payment, interest: schedule.reduce((sum, row) => sum + row.scheduledInterestCents, 0), terms, method };
  }

  function renderCalculator() {
    view.innerHTML = `<section class="panel"><h2>方案测算</h2>
      <form id="quote-form" class="form-grid">
        <label>测算方式<select name="mode"><option value="quote">按车价与首付报价</option><option value="reverse">按月供倒推贷款额</option></select></label>
        <label>计息方式<select name="interestMethod"><option value="flat">平息 / 固定月息</option><option value="annuity">标准等额本息</option></select></label>
        <label>车辆价格（元）<input name="vehiclePrice" type="number" min="0.01" step="0.01" value="91800" required></label>
        <label>首付比例（%）<input name="downPaymentRate" type="number" min="0" max="99.99" step="0.01" value="15" required></label>
        <label>目标月供（元）<input name="targetPayment" type="number" min="0.01" step="0.01" value="3142.88" required></label>
        <label>月利率（%）<input name="monthlyRate" type="number" min="0" step="0.01" value="1.25" required></label>
        <label>期数（月）<input name="terms" type="number" min="1" max="120" value="36" required></label>
        <label>押金（月数，不参与计算）<input name="depositMonths" type="number" min="0" value="1"></label>
      </form>
      <div id="quote-result" class="summary-box" style="margin-top:16px"></div>
      <div class="actions"><button type="button" id="copy-quote">复制报价文字</button></div>
    </section>
    <section class="panel"><h2>滞纳金计算</h2><form id="late-form" class="form-grid">
      <label>本期剩余应付款（元）<input name="amount" type="number" min="0" step="0.01" value="3142.88"></label>
      <label>日滞纳金比例（%）<input name="rate" type="number" min="0" step="0.01" value="0.5"></label>
      <label>应付日期<input name="dueDate" type="date" value="${todayKey()}"></label>
      <label>计算日期<input name="payDate" type="date" value="${todayKey()}"></label>
    </form><div id="late-result" class="summary-box" style="margin-top:16px"></div><div class="actions"><button type="button" id="copy-late">复制滞纳金文字</button></div></section>`;
    const quoteForm = $('quote-form');
    const lateForm = $('late-form');
    function updateQuote() {
      try {
        const result = calculateQuote(new FormData(quoteForm));
        const method = result.method === 'annuity' ? '标准等额本息' : '平息 / 固定月息';
        const text = `车辆价格：${money(result.price)}元\n首付：${money(result.down)}元\n贷款金额：${money(result.loan)}元\n期数：${result.terms}个月\n计息方式：${method}\n参考月供：${money(result.payment)}元\n押金：${quoteForm.elements.depositMonths.value || 0}个月（不参与贷款计算）\n总利息：${money(result.interest)}元`;
        $('quote-result').innerHTML = `<strong>参考月供 ${money(result.payment)}元</strong><br>贷款 ${money(result.loan)}元 · 首付 ${money(result.down)}元 · 总利息 ${money(result.interest)}元<div class="copy-text" style="margin-top:12px">${escapeHtml(text)}</div>`;
        $('quote-result').dataset.copy = text;
      } catch (_error) { $('quote-result').textContent = '请填写完整、有效的测算数据。'; }
    }
    function updateLate() {
      try {
        const form = new FormData(lateForm);
        const amount = domain.yuanToCents(form.get('amount'));
        const days = Math.max(0, domain.daysBetweenDateKeys(form.get('payDate'), form.get('dueDate')));
        const fee = domain.calculateLateFeeCents(amount, domain.percentToBps(form.get('rate')), days);
        const text = `本期应付款：${money(amount)}元\n应付日期：${form.get('dueDate')}\n计算日期：${form.get('payDate')}\n逾期天数：${days}天\n参考滞纳金：${money(fee)}元\n参考合计：${money(amount + fee)}元`;
        $('late-result').innerHTML = `<strong>参考合计 ${money(amount + fee)}元</strong><br>逾期${days}天 · 滞纳金 ${money(fee)}元<div class="copy-text" style="margin-top:12px">${escapeHtml(text)}</div>`;
        $('late-result').dataset.copy = text;
      } catch (_error) { $('late-result').textContent = '请填写完整、有效的日期和金额。'; }
    }
    quoteForm.oninput = updateQuote;
    quoteForm.onchange = updateQuote;
    lateForm.oninput = updateLate;
    lateForm.onchange = updateLate;
    $('copy-quote').onclick = () => navigator.clipboard.writeText($('quote-result').dataset.copy || '');
    $('copy-late').onclick = () => navigator.clipboard.writeText($('late-result').dataset.copy || '');
    updateQuote(); updateLate();
  }

  async function renderCustomers(options = {}) {
    const rows = await cachedApiCall('customers.list', {}, { force: options.force, maxAgeMs: 30000 });
    view.innerHTML = `<section class="panel">
      <div class="section-title"><h2>客户合同</h2><div class="actions section-actions"><button type="button" class="secondary" id="refresh-customers">刷新</button><button type="button" id="show-customer-form">新增客户</button></div></div>
      <form id="customer-search" class="actions"><input name="keyword" placeholder="搜索姓名、车牌或车辆" style="flex:1"><button type="submit">搜索</button></form>
      <div id="customer-list" class="list" style="margin-top:16px">${customerListHtml(rows)}</div>
    </section>
    <section class="panel" id="customer-create-panel" hidden><h2>新增客户和合同</h2>${customerFormHtml()}</section>`;
    bindCustomerRows();
    $('refresh-customers').onclick = () => navigate('customers', { force: true });
    $('show-customer-form').onclick = () => { $('customer-create-panel').hidden = false; $('customer-create-panel').scrollIntoView({ behavior: 'smooth' }); };
    $('customer-search').onsubmit = async event => {
      event.preventDefault();
      const result = await apiCall('customers.list', { keyword: new FormData(event.currentTarget).get('keyword') });
      $('customer-list').innerHTML = customerListHtml(result); bindCustomerRows();
    };
    bindCreateCustomer();
  }

  function customerListHtml(rows) {
    if (!rows.length) return '<p class="empty">还没有客户合同。</p>';
    return rows.map(row => `<button type="button" class="list-item" data-customer="${escapeHtml(row._id)}"><span><h3>${escapeHtml(row.name)}</h3><p>${escapeHtml(row.plate || '未填车牌')} · ${escapeHtml(row.vehicle || '未填车辆')}</p></span><span>查看详情 ›</span></button>`).join('');
  }

  function bindCustomerRows() {
    view.querySelectorAll('[data-customer]').forEach(button => button.onclick = () => navigate('customer', { customerId: button.dataset.customer }));
  }

  function customerFormHtml() {
    return `<form id="customer-create-form" class="form-grid">
      <label>客户姓名<input name="name" maxlength="60" required></label><label>车牌号<input name="plate" maxlength="30"></label>
      <label>车辆<input name="vehicle" maxlength="100"></label><label>计息方式<select name="interestMethod"><option value="flat">平息 / 固定月息</option><option value="annuity">标准等额本息</option></select></label>
      <label>车辆价格（元）<input name="vehiclePrice" type="number" min="0.01" step="0.01" value="91800" required></label><label>首付比例（%）<input name="downPaymentRate" type="number" min="0" max="99.99" step="0.01" value="15" required></label>
      <label>月利率（%）<input name="monthlyRate" type="number" min="0" step="0.01" value="1.25" required></label><label>期数（月）<input name="terms" type="number" min="1" max="120" value="36" required></label>
      <label>首期应还日期<input name="startDateKey" type="date" value="${todayKey()}" required></label><label>每月还款日<input name="dueDay" type="number" min="1" max="31" value="5" required></label>
      <label>日滞纳金比例（%）<input name="dailyLateFeeRate" type="number" min="0" step="0.01" value="0.5"></label><label>押金月数（不参与贷款计算）<input name="depositMonths" type="number" min="0" value="1"></label>
      <label class="full">备注<textarea name="notes" maxlength="500"></textarea></label>
      <div id="contract-preview" class="summary-box full"></div><div class="actions full"><button type="submit">建立客户合同</button></div>
    </form>`;
  }

  function bindCreateCustomer() {
    const form = $('customer-create-form');
    function preview() {
      try {
        const value = calculateQuote(new FormData(form));
        $('contract-preview').innerHTML = `贷款 <strong>${money(value.loan)}元</strong> · 首付 ${money(value.down)}元 · 参考月供 ${money(value.payment)}元`;
      } catch (_error) { $('contract-preview').textContent = '请填写完整合同数据。'; }
    }
    form.oninput = preview; form.onchange = preview; preview();
    form.onsubmit = async event => {
      event.preventDefault();
      const button = event.submitter;
      const data = new FormData(form);
      setBusy(button, true, '正在建立…');
      try {
        const customer = await apiCall('customers.save', { name: data.get('name'), plate: data.get('plate'), vehicle: data.get('vehicle'), notes: data.get('notes') });
        await apiCall('contracts.create', {
          customerId: customer.customerId,
          interestMethod: data.get('interestMethod'),
          vehiclePriceCents: domain.yuanToCents(data.get('vehiclePrice')),
          downPaymentRateBps: domain.percentToBps(data.get('downPaymentRate')),
          monthlyRateBps: domain.percentToBps(data.get('monthlyRate')),
          terms: Number(data.get('terms')),
          depositMonths: Number(data.get('depositMonths') || 0),
          dueDay: Number(data.get('dueDay')),
          startDateKey: data.get('startDateKey'),
          dailyLateFeeRateBps: domain.percentToBps(data.get('dailyLateFeeRate') || 0)
        });
        clearBusinessCache();
        showNotice('客户合同已建立。');
        await navigate('customer', { customerId: customer.customerId });
      } catch (error) { showNotice(error.message, true); }
      finally { setBusy(button, false); }
    };
  }

  function planStatus(row) {
    return row.status === 'paid' ? '已结清' : row.status === 'partial' ? '部分还款' : '待还';
  }

  async function renderCustomerDetail(customerId, options = {}) {
    const detail = await cachedApiCall('customers.detail', { customerId }, { force: options.force, maxAgeMs: 15000 });
    state.detail = detail;
    const depositBalanceCents = detail.deposits
      .filter(item => item.status === 'active')
      .reduce((sum, item) => sum + (item.direction === 'out' ? -item.amountCents : item.amountCents), 0);
    const settlement = detail.contract
      ? domain.settlementBreakdown(detail.repaymentPlans, Math.max(0, depositBalanceCents))
      : null;
    const next = detail.repaymentPlans.find(row => row.status !== 'paid');
    view.innerHTML = `<section class="panel"><div class="section-title"><div><h2>${escapeHtml(detail.customer.name)}</h2><p class="muted">${escapeHtml(detail.customer.plate || '未填车牌')} · ${escapeHtml(detail.customer.vehicle || '未填车辆')}</p></div><button type="button" class="secondary" id="back-customers">返回客户列表</button></div></section>
    ${detail.contract ? `<section class="panel"><h2>合同概况</h2><div class="grid three"><div class="metric"><span>车辆价格</span><strong>${money(detail.contract.vehiclePriceCents)}元</strong></div><div class="metric"><span>贷款金额</span><strong>${money(detail.contract.principalCents)}元</strong></div><div class="metric"><span>参考月供</span><strong>${money(detail.contract.quotedMonthlyPaymentCents)}元</strong></div></div><p class="muted">${detail.contract.interestMethod === 'annuity' ? '标准等额本息' : '平息 / 固定月息'} · ${detail.contract.terms}期 · 押金${detail.contract.depositMonths || 0}个月（独立记录）</p></section>
    <section class="panel"><h2>合同结清核算</h2><div class="summary-box">已还本金 ${money(settlement.paidPrincipalCents)}元 · 已还利息 ${money(settlement.paidInterestCents)}元<br>剩余本金 ${money(settlement.remainingPrincipalCents)}元 · 剩余合同利息 ${money(settlement.remainingInterestCents)}元<br><strong>合同结清参考 ${money(settlement.contractSettlementCents)}元</strong><br>押金余额 ${money(settlement.depositBalanceCents)}元（不自动抵扣）</div><div class="actions"><button type="button" id="copy-settlement">复制结清文字</button><button type="button" class="secondary" id="copy-overdue">复制逾期催款</button></div></section>
    <section class="panel"><h2>登记收款</h2><form id="payment-form" class="form-grid"><label>到账总额（元）<input name="amount" type="number" min="0.01" step="0.01" value="${next ? money(domain.remainingContractCents(next)).replace(/,/g, '') : ''}" required></label><label>其中滞纳金（元）<input name="lateFee" type="number" min="0" step="0.01" value="0"></label><label>收款日期<input name="receivedDateKey" type="date" value="${todayKey()}" required></label><label>从第几期分配<input name="startTermNo" type="number" min="1" value="${next ? next.termNo : 1}" required></label><label class="full">备注<input name="notes" maxlength="300"></label><div class="actions full"><button type="submit">确认登记收款</button></div></form></section>
    <section class="panel"><h2>押金记录</h2><p class="muted">押金独立记账，不参与贷款额、月供或自动结清计算。</p><form id="deposit-form" class="form-grid"><label>方向<select name="direction"><option value="in">收取押金</option><option value="out">退还/支出押金</option></select></label><label>金额（元）<input name="amount" type="number" min="0.01" step="0.01" required></label><label>发生日期<input name="occurredDateKey" type="date" value="${todayKey()}" required></label><label>备注<input name="notes" maxlength="300"></label><div class="actions full"><button type="submit">登记押金</button></div></form></section>
    <section class="panel"><h2>还款计划</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>期数</th><th>到期日</th><th>应还</th><th>已还</th><th>剩余</th><th>状态</th></tr></thead><tbody>${detail.repaymentPlans.map(row => `<tr><td>第${row.termNo}期</td><td>${escapeHtml(row.dueDateKey)}</td><td>${money(row.scheduledAmountCents)}</td><td>${money((row.paidPrincipalCents || 0) + (row.paidInterestCents || 0))}</td><td>${money(domain.remainingContractCents(row))}</td><td><span class="status-pill ${escapeHtml(row.status)}">${planStatus(row)}</span></td></tr>`).join('')}</tbody></table></div></section>
    <section class="panel"><h2>收款流水</h2>${detail.payments.length ? `<div class="list">${detail.payments.map(item => `<div class="list-item"><span><h3>${money(item.amountCents)}元</h3><p>${escapeHtml(item.receivedDateKey)} · 滞纳金${money(item.lateFeeCents)}元 · ${item.status === 'reversed' ? '已撤销' : '有效'}</p></span>${item.status === 'active' ? `<button type="button" class="danger" data-reverse="${escapeHtml(item._id)}">撤销</button>` : ''}</div>`).join('')}</div>` : '<p class="empty">暂无收款流水。</p>'}</section>
    <section class="panel"><h2>押金流水</h2>${detail.deposits.length ? `<div class="list">${detail.deposits.map(item => `<div class="list-item"><span><h3>${item.direction === 'out' ? '退还/支出' : '收取'} ${money(item.amountCents)}元</h3><p>${escapeHtml(item.occurredDateKey || '')} · ${escapeHtml(item.notes || '')}</p></span></div>`).join('')}</div>` : '<p class="empty">暂无押金流水。</p>'}</section>` : '<section class="panel"><p class="empty">该客户还没有合同。</p></section>'}`;
    $('back-customers').onclick = () => navigate('customers');
    if (!detail.contract) return;
    $('copy-settlement').onclick = () => navigator.clipboard.writeText(`${detail.customer.name}合同结清核算\n剩余本金：${money(settlement.remainingPrincipalCents)}元\n剩余合同利息：${money(settlement.remainingInterestCents)}元\n合同结清参考：${money(settlement.contractSettlementCents)}元\n押金余额：${money(settlement.depositBalanceCents)}元\n押金不自动抵扣，最终以合同及双方确认为准。`);
    $('copy-overdue').onclick = () => copyOverdue(detail);
    $('payment-form').onsubmit = event => submitPayment(event, detail.contract._id);
    $('deposit-form').onsubmit = event => submitDeposit(event, detail.contract._id);
    view.querySelectorAll('[data-reverse]').forEach(button => button.onclick = () => reversePayment(button.dataset.reverse));
  }

  async function submitPayment(event, contractId) {
    event.preventDefault();
    const button = event.submitter;
    const form = new FormData(event.currentTarget);
    setBusy(button, true, '登记中…');
    try {
      await apiCall('payments.record', { contractId, amountCents: domain.yuanToCents(form.get('amount')), lateFeeCents: domain.yuanToCents(form.get('lateFee') || 0), receivedDateKey: form.get('receivedDateKey'), startTermNo: Number(form.get('startTermNo')), notes: form.get('notes') });
      clearBusinessCache();
      showNotice('收款已登记。');
      await navigate('customer', { customerId: state.customerId });
    } catch (error) { showNotice(error.message, true); }
    finally { setBusy(button, false); }
  }

  async function submitDeposit(event, contractId) {
    event.preventDefault();
    const button = event.submitter;
    const form = new FormData(event.currentTarget);
    setBusy(button, true, '登记中…');
    try {
      await apiCall('deposits.record', { contractId, direction: form.get('direction'), amountCents: domain.yuanToCents(form.get('amount')), occurredDateKey: form.get('occurredDateKey'), notes: form.get('notes') });
      clearBusinessCache();
      showNotice('押金流水已登记，未进入贷款计算。');
      await navigate('customer', { customerId: state.customerId });
    } catch (error) { showNotice(error.message, true); }
    finally { setBusy(button, false); }
  }

  async function reversePayment(paymentId) {
    if (!window.confirm('撤销后各期欠款会恢复，原流水会保留并标记为已撤销。确定继续吗？')) return;
    try {
      await apiCall('payments.reverse', { paymentId, reason: '管理员在网页端撤销' });
      clearBusinessCache();
      showNotice('收款已撤销。');
      await navigate('customer', { customerId: state.customerId });
    } catch (error) { showNotice(error.message, true); }
  }

  function copyOverdue(detail) {
    const overdue = detail.repaymentPlans.filter(row => row.status !== 'paid' && domain.daysBetweenDateKeys(row.dueDateKey, todayKey()) < 0);
    if (!overdue.length) return showNotice('当前没有逾期账单。');
    let contractTotal = 0, feeTotal = 0;
    const lines = overdue.map(row => {
      const remaining = domain.remainingContractCents(row);
      const days = -domain.daysBetweenDateKeys(row.dueDateKey, todayKey());
      const fee = domain.calculateLateFeeCents(remaining, row.dailyLateFeeRateBps || 0, days);
      contractTotal += remaining; feeTotal += fee;
      return `第${row.termNo}期：应付日${row.dueDateKey}，逾期${days}天，剩余${money(remaining)}元，参考滞纳金${money(fee)}元`;
    });
    navigator.clipboard.writeText(`您好，${detail.customer.name}，您目前有${overdue.length}期车辆款项已逾期。\n\n${lines.join('\n')}\n\n逾期未付合同款：${money(contractTotal)}元\n参考滞纳金：${money(feeTotal)}元\n合计应付：${money(contractTotal + feeTotal)}元\n\n请您今天安排付款，谢谢。`);
    showNotice('逾期催款文字已复制。');
  }

  async function renderSettings() {
    const session = await apiCall('session');
    view.innerHTML = `<section class="panel"><h2>云端账号</h2><p>${escapeHtml(session.appName)} · ${escapeHtml(session.version)}</p><p class="muted">管理员：${escapeHtml(session.ownerOpenIdMasked)}</p><p class="cost-warning">正式扩展前必须重新核算：CloudBase套餐、数据库容量、函数调用量、静态托管流量、域名、HTTPS、备案、备份空间和后续维护成本。</p></section>
    <section class="panel"><h2>旧网页数据迁移</h2><p class="muted">粘贴原 GitHub Pages 导出的完整备份文本或JSON。先校验预览，不覆盖已有记录；重复旧ID会跳过。</p><textarea id="migration-backup" placeholder="粘贴旧网页备份"></textarea><div class="actions"><button type="button" id="preview-migration">校验并预览</button></div><div id="migration-result" style="margin-top:14px"></div></section>
    <section class="panel"><h2>云端备份</h2><p class="muted">导出所有客户、合同、账单、收款、押金和审计数据，并附带SHA-256校验值。</p><div class="actions"><button type="button" id="export-cloud-backup">复制云端备份</button></div><textarea id="cloud-backup-output" readonly placeholder="导出后在这里显示，也会尝试复制到剪贴板"></textarea></section>
    <section class="panel"><h2>安装到手机桌面</h2><p>iPhone请用Safari打开后选择“共享 → 添加到主屏幕”；安卓浏览器选择“安装应用”或“添加到主屏幕”。</p><p class="install-note">微信内置浏览器通常不能直接完成PWA安装。</p></section>`;
    $('preview-migration').onclick = previewMigration;
    $('export-cloud-backup').onclick = exportCloudBackup;
  }

  async function previewMigration(event) {
    const backup = $('migration-backup').value.trim();
    if (!backup) return showNotice('请先粘贴旧网页备份。', true);
    const button = event.currentTarget;
    setBusy(button, true, '校验中…');
    try {
      const result = await apiCall('migration.preview', { backup });
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      const warningHtml = warnings.length
        ? `<div class="summary-box" style="margin-top:10px"><strong>导入前请核对</strong><ul>${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
        : '';
      $('migration-result').innerHTML = `<div class="summary-box">客户 ${result.summary.customers} 位 · 合同 ${result.summary.contracts} 份 · 收款 ${result.summary.payments} 笔<br>合同本金 ${money(result.summary.contractPrincipalCents)}元 · 计划利息 ${money(result.summary.scheduledInterestCents)}元 · 已收 ${money(result.summary.receivedCents)}元</div>${warningHtml}<div class="actions"><button type="button" id="confirm-migration">确认导入云数据库</button></div><div id="migration-progress" class="migration-progress" hidden></div>`;
      $('confirm-migration').onclick = migrationEvent => importMigration(migrationEvent, backup, result.summary);
      showNotice('迁移预览通过，核对汇总和提示后再确认导入。');
    } catch (error) {
      const errors = Array.isArray(error.details && error.details.errors) ? error.details.errors : [];
      const warnings = Array.isArray(error.details && error.details.warnings) ? error.details.warnings : [];
      const reasons = [...errors, ...warnings];
      showNotice(errors[0] || error.message, true);
      $('migration-result').innerHTML = reasons.length
        ? `<div class="summary-box"><strong class="error">未通过原因</strong><ul>${reasons.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p class="muted">原备份没有被修改，也没有写入云数据库。请保留完整备份。</p></div>`
        : '';
    }
    finally { setBusy(button, false); }
  }

  async function importMigration(event, backup, summary) {
    if (!window.confirm(`将导入${summary.customers}位客户、${summary.contracts}份合同。重复旧ID会跳过，确定继续吗？`)) return;
    const button = event.currentTarget;
    const progressNode = $('migration-progress');
    setBusy(button, true, '准备导入…');
    progressNode.hidden = false;
    try {
      let result;
      let attempts = 0;
      do {
        attempts += 1;
        progressNode.textContent = `正在分批导入，请勿关闭页面（第${attempts}批）…`;
        result = await apiCall('migration.import', { backup }, { timeoutMs: 45000 });
        const progress = result.progress || { completed: summary.customers, total: summary.customers, remaining: 0 };
        progressNode.innerHTML = `<strong>已处理 ${progress.completed}/${progress.total} 位客户</strong><span>剩余 ${progress.remaining} 位；每位客户完成后都会保存，可断点继续。</span>`;
        setBusy(button, true, progress.remaining ? `已完成 ${progress.completed}/${progress.total}` : '导入完成');
        if (attempts > summary.customers + 2) throw new Error('导入进度异常，请刷新页面后继续。');
      } while (result.status === 'running');
      clearBusinessCache();
      const failed = (result.results || []).filter(item => item.status === 'failed').length;
      progressNode.innerHTML += `<span>任务 ${escapeHtml(result.migrationJobId)} · ${result.status === 'duplicate' ? '该备份已导入，无需重复处理' : failed ? `完成，但有${failed}位失败` : '全部完成'}</span>`;
      showNotice(failed ? `迁移完成，但有${failed}位客户失败，请保留原备份。` : '旧网页数据迁移处理完成。', failed > 0);
    } catch (error) {
      progressNode.innerHTML += `<span class="error">${escapeHtml(error.message)} 可以点击按钮从断点继续，不会重复已完成客户。</span>`;
      showNotice(error.message, true);
    } finally {
      setBusy(button, false);
      button.textContent = '继续 / 重新检查导入';
    }
  }

  async function exportCloudBackup(event) {
    const button = event.currentTarget;
    setBusy(button, true, '导出中…');
    try {
      const backup = await apiCall('backup.export');
      const text = `【大进车贷助手云端备份】\n版本：v2\n导出时间：${backup.exportedAt}\n校验值：${backup.checksum}\n数据：\n${JSON.stringify(backup, null, 2)}`;
      $('cloud-backup-output').value = text;
      await navigator.clipboard.writeText(text);
      showNotice('云端备份已复制，请保存到受保护的位置。');
    } catch (error) { showNotice(error.message, true); }
    finally { setBusy(button, false); }
  }

  async function bootstrap() {
    $('login-form').onsubmit = login;
    $('logout-button').onclick = () => logout(true);
    $('offline-calculator').onclick = () => { showApp(true); navigate('calculator'); };
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (!state.token) return showApp(false);
    showApp(true);
    try {
      await apiCall('session');
      await navigate('dashboard');
    } catch (_error) {
      logout(true);
      $('login-error').textContent = '登录已失效，请重新输入管理员密码。';
    }
  }

  bootstrap();
})();
