(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RentalCalculation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_CENTS = 10000000000; // 100 million yuan; keep every amount safely representable.
  function amount(value, label) {
    const text = String(value).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error(`${label}请输入非负金额，最多2位小数。`);
    const [whole, fraction = ''] = text.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new Error(`${label}不能超过100,000,000元。`);
    return cents;
  }
  function dateParts(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效的首次付款日期。');
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1900 || year > 9990 || month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0, 12).getDate()) throw new Error('请选择有效的首次付款日期。');
    return { year, month, day };
  }
  function dueDate(firstDate, offset) {
    const { year, month, day } = dateParts(firstDate);
    // Anchor every term to the original day, never to the previously clamped month.
    const first = new Date(year, month - 1 + offset, 1, 12);
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12).getDate();
    return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  }
  function calculate(draft, pricing) {
    const terms = Number(draft.terms);
    if (!/^\d+$/.test(String(draft.terms)) || !Number.isInteger(terms) || terms < 1 || terms > 120) throw new Error('租赁期限请输入1至120期的整数。');
    const rateText = String(draft.ratePct).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(rateText) || Number(rateText) > 100) throw new Error('内部月费率请输入0至100%，最多6位小数。');
    const rate = Number(rateText) / 100;
    // Exact decimal representation of the existing flat-fee formula. No binary-float
    // or intermediate rounding may move a value across a half-cent boundary.
    const rateDigits = (rateText.split('.')[1] || '').length;
    const rateNumerator = BigInt(rateText.replace('.', ''));
    const rateDenominator = 100n * 10n ** BigInt(rateDigits);
    const termCount = BigInt(terms);
    const roundRatio = (numerator, denominator) => Number((numerator * 2n + denominator) / (denominator * 2n));
    function months(value, label, limit) {
      if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > limit) throw new Error(`${label}请输入0至${limit}个月的整数。`);
      return Number(value);
    }
    const prepaidMonths = months(draft.prepaidMonths, '预付租金', terms);
    const depositMonths = months(draft.depositMonths, '押金', 120);
    let vehicleAmountCents;
    if (draft.mode === 'reverse') {
      const targetCents = amount(draft.target, '月租预算');
      if (!targetCents) throw new Error('月租预算必须大于0。');
      // Floor to cents so the suggested scheme amount does not exceed the budget.
      vehicleAmountCents = Number(BigInt(targetCents) * termCount * rateDenominator / (rateDenominator + rateNumerator * termCount));
      if (!Number.isSafeInteger(vehicleAmountCents) || vehicleAmountCents > MAX_CENTS) throw new Error('倒推车辆方案金额超出支持范围。');
    } else vehicleAmountCents = amount(draft.vehicleAmount, '车辆方案金额');
    if (vehicleAmountCents <= 0) throw new Error('车辆方案金额必须大于0。');
    const base = vehicleAmountCents / 100;
    // Reuse the existing flat-rate engine. Prepaid rent is deliberately not subtracted.
    const payment = pricing.monthlyPayment(base, rate, terms, 'flat');
    const totals = pricing.repaymentTotals(base, payment, rate, terms, 'flat');
    const totalNumerator = BigInt(vehicleAmountCents) * (rateDenominator + rateNumerator * termCount);
    const fixedMonthlyCents = roundRatio(totalNumerator, rateDenominator * termCount);
    const totalRentCents = roundRatio(totalNumerator, rateDenominator);
    if (totalRentCents > MAX_CENTS) throw new Error('租金总额不能超过100,000,000元。');
    // Guard against accidental future changes to the shared pricing functions.
    if (Math.abs(totalRentCents / 100 - totals.totalRepayment) > .00501 || Math.abs(fixedMonthlyCents / 100 - payment) > .00501) throw new Error('计价引擎与分币精度校验不一致，已停止生成。');
    const lastRentCents = totalRentCents - fixedMonthlyCents * (terms - 1);
    if (fixedMonthlyCents <= 0 || lastRentCents < 0) throw new Error('方案金额过小，无法按当前期数分配到分，请调整金额或期数。');
    // A full-term prepayment covers the adjusted final instalment exactly.
    const prepaidCents = prepaidMonths === terms ? totalRentCents : fixedMonthlyCents * prepaidMonths;
    const depositCents = fixedMonthlyCents * depositMonths;
    if (!Number.isSafeInteger(depositCents) || depositCents > MAX_CENTS) throw new Error('押金折算金额超出支持范围，请减少月数。');
    dateParts(draft.firstDate);
    if (String(draft.vehicle || '').trim().length > 80 || String(draft.customer || '').trim().length > 40) throw new Error('车辆名称最多80字，客户姓名最多40字。');
    let availablePrepaid = prepaidCents, remainingRent = totalRentCents;
    const paymentSchedule = Array.from({ length: terms }, (_, index) => {
      const plannedCents = index === terms - 1 ? lastRentCents : fixedMonthlyCents;
      const offsetCents = Math.min(availablePrepaid, plannedCents);
      availablePrepaid -= offsetCents;
      remainingRent -= plannedCents;
      return Object.freeze({ term: index + 1, dueDate: dueDate(draft.firstDate, index), plannedCents, offsetCents, dueCents: plannedCents - offsetCents, remainingCents: remainingRent });
    });
    return Object.freeze({
      vehicle: String(draft.vehicle || '').trim(), customer: String(draft.customer || '').trim(), phone: String(draft.phone || '').trim().slice(0, 24),
      terms, firstDate: draft.firstDate, vehicleAmountCents, ratePct: Number(rateText),
      fixedMonthlyCents, totalRentCents, prepaidMonths, depositMonths, prepaidCents, depositCents,
      feeCents: totalRentCents - vehicleAmountCents, outstandingCents: totalRentCents - prepaidCents,
      tailAdjustmentCents: lastRentCents - fixedMonthlyCents,
      paymentSchedule: Object.freeze(paymentSchedule)
    });
  }
  return { calculate, dueDate, amount };
});
