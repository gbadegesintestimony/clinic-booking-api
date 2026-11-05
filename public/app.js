(() => {
  // 1. WeakMap-based fallback for :user-invalid / :user-valid + ARIA sync
  const UserInvalidFallback = (() => {
    const dirtyState = new WeakMap();

    const updateState = (input) => {
      const isValid = input.checkValidity();
      input.classList.toggle('user-invalid-fallback', !isValid);
      input.classList.toggle('user-valid-fallback', isValid);
      if (!isValid) {
        input.setAttribute('aria-invalid', 'true');
      } else {
        input.removeAttribute('aria-invalid');
      }
    };

    const handleEvent = (event) => {
      const input = event.target;
      if (event.type === 'reset') {
        const controls = input.elements || [];
        for (const control of controls) {
          dirtyState.delete(control);
          control.classList.remove('user-invalid-fallback', 'user-valid-fallback');
          control.removeAttribute('aria-invalid');
        }
        return;
      }
      if (!input || typeof input.checkValidity !== 'function') return;

      if (event.type === 'input' || event.type === 'change') {
        const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
        state.hasInteracted = true;
        dirtyState.set(input, state);
        if (state.hasBlurred) {
          updateState(input);
        }
      } else if (event.type === 'blur') {
        const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
        state.hasBlurred = true;
        dirtyState.set(input, state);
        if (state.hasInteracted) {
          updateState(input);
        }
      }
    };

    const init = (root = document) => {
      if (!CSS.supports('selector(:user-invalid)')) {
        root.addEventListener('blur', handleEvent, true);
        root.addEventListener('input', handleEvent);
        root.addEventListener('change', handleEvent);
        root.addEventListener('reset', handleEvent, true);
      } else {
        const syncAria = (el) => {
          if (el && typeof el.matches === 'function' && el.tagName === 'INPUT') {
            el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
          }
        };
        root.addEventListener('blur', (e) => syncAria(e.target), true);
        root.addEventListener('input', (e) => {
          if (e.target && e.target.hasAttribute && e.target.hasAttribute('aria-invalid')) {
            syncAria(e.target);
          }
        });
      }
    };

    return { init };
  })();

  UserInvalidFallback.init(document);

  // DOM Elements
  const apiKeyInput = document.getElementById('api-key-input');
  const idemKeyInput = document.getElementById('idempotency-key-input');
  const newIdemKeyBtn = document.getElementById('new-idem-key-btn');
  const slotsListEl = document.getElementById('slots-list');
  const slotsFeedbackEl = document.getElementById('slots-feedback');
  const providerFilterEl = document.getElementById('provider-filter');
  const filterForm = document.getElementById('filter-form');
  const refreshSlotsBtn = document.getElementById('refresh-slots-btn');

  const bookingForm = document.getElementById('booking-form');
  const slotIdInput = document.getElementById('slot-id-input');
  const patientNameInput = document.getElementById('patient-name-input');
  const patientEmailInput = document.getElementById('patient-email-input');
  const bookingAlertEl = document.getElementById('booking-form-alert');
  const bookSubmitBtn = document.getElementById('book-submit-btn');

  const confirmationCard = document.getElementById('confirmation-card');
  const confirmationHeading = document.getElementById('confirmation-heading');
  const confirmationSubtitle = document.getElementById('confirmation-subtitle');
  const confirmationDetails = document.getElementById('confirmation-details');
  const cancelConfirmedBtn = document.getElementById('cancel-confirmed-btn');
  const viewModalBtn = document.getElementById('view-modal-btn');

  const confirmationDialog = document.getElementById('confirmation-dialog');
  const dialogTitle = document.getElementById('dialog-title');
  const dialogDetails = document.getElementById('dialog-details');
  const dialogCancelBookingBtn = document.getElementById('dialog-cancel-booking-btn');

  const lookupIdForm = document.getElementById('lookup-id-form');
  const lookupIdInput = document.getElementById('lookup-id-input');

  const lookupEmailForm = document.getElementById('lookup-email-form');
  const lookupEmailInput = document.getElementById('lookup-email-input');
  const lookupLimitInput = document.getElementById('lookup-limit-input');
  const patientBookingsContainer = document.getElementById('patient-bookings-container');
  const patientBookingsList = document.getElementById('patient-bookings-list');
  const cursorStatus = document.getElementById('cursor-status');
  const firstPageBtn = document.getElementById('first-page-btn');
  const nextPageBtn = document.getElementById('next-page-btn');

  const resetDemoBtn = document.getElementById('reset-demo-btn');

  // State
  let allSlotsCache = [];
  let selectedSlotId = '';
  let activeBooking = null;
  let currentPaginationCursor = null;
  let knownProviders = new Set();

  function generateIdempotencyKey() {
    if (window.crypto && window.crypto.randomUUID) {
      return 'idem_' + window.crypto.randomUUID();
    }
    return 'idem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function getApiKey() {
    return (apiKeyInput.value || '').trim();
  }

  async function apiFetch(path, options = {}) {
    const headers = {
      'X-API-Key': getApiKey(),
      ...(options.headers || {})
    };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(path, {
      ...options,
      headers
    });
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      data
    };
  }

  function formatDateTimeRange(startIso, endIso) {
    try {
      const startDate = new Date(startIso);
      const endDate = new Date(endIso);
      const dateFormatter = new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
      const timeFormatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      });
      return `${dateFormatter.format(startDate)} · ${timeFormatter.format(startDate)} – ${timeFormatter.format(endDate)}`;
    } catch (_) {
      return `${startIso} – ${endIso}`;
    }
  }

  function showFormAlert(message, type = 'error') {
    bookingAlertEl.textContent = message;
    bookingAlertEl.className = `alert-box ${type}`;
    bookingAlertEl.hidden = false;
  }

  function clearFormAlert() {
    bookingAlertEl.hidden = true;
    bookingAlertEl.textContent = '';
  }

  function populateBookingDetailsList(dlElement, booking) {
    dlElement.replaceChildren();
    const matchingSlot = allSlotsCache.find((s) => s.id === booking.slot_id);
    const entries = [
      ['Booking ID', booking.id],
      ['Status', booking.status.toUpperCase()],
      ['Slot ID', booking.slot_id],
      [
        'Slot Schedule',
        matchingSlot
          ? `${matchingSlot.provider} (${formatDateTimeRange(matchingSlot.start, matchingSlot.end)})`
          : booking.slot_id
      ],
      ['Patient Name', booking.name],
      ['Patient Email', booking.email],
      ['Created At', booking.created_at]
    ];

    for (const [term, def] of entries) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = def;
      dlElement.append(dt, dd);
    }
  }

  function renderConfirmation(booking, openModal = false) {
    activeBooking = booking;
    confirmationCard.hidden = false;
    const isCancelled = booking.status === 'cancelled';
    confirmationCard.classList.toggle('is-cancelled', isCancelled);

    confirmationHeading.textContent = isCancelled
      ? 'Booking Cancelled'
      : 'Booking Confirmation';
    confirmationSubtitle.textContent = isCancelled
      ? 'This appointment has been cancelled and the slot is now free.'
      : 'Your appointment is confirmed.';

    cancelConfirmedBtn.disabled = isCancelled;
    dialogCancelBookingBtn.disabled = isCancelled;

    populateBookingDetailsList(confirmationDetails, booking);
    populateBookingDetailsList(dialogDetails, booking);
    dialogTitle.textContent = isCancelled ? 'Appointment Cancelled' : 'Appointment Confirmed';

    if (openModal && typeof confirmationDialog.showModal === 'function') {
      confirmationDialog.showModal();
    }
  }

  function selectSlot(slotId) {
    selectedSlotId = slotId;
    slotIdInput.value = slotId;
    slotIdInput.setCustomValidity('');
    slotIdInput.classList.remove('user-invalid-fallback');
    slotIdInput.removeAttribute('aria-invalid');
    clearFormAlert();
    renderSlots(allSlotsCache);
    patientNameInput.focus();
  }

  function renderSlots(slots) {
    slotsListEl.replaceChildren();
    if (!slots || slots.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'section-desc';
      emptyMsg.textContent = 'No slots found matching the current filter.';
      slotsListEl.append(emptyMsg);
      return;
    }

    const nowMs = Date.now();

    for (const slot of slots) {
      const isPast = Date.parse(slot.start) <= nowMs;
      const isBookable = slot.available && !isPast;
      const card = document.createElement('article');
      card.className = 'slot-card';
      card.setAttribute('role', 'listitem');
      if (selectedSlotId === slot.id) {
        card.classList.add('is-selected');
      }
      if (!isBookable) {
        card.classList.add('is-unavailable');
      }

      const topRow = document.createElement('div');
      topRow.className = 'slot-top';

      const idBadge = document.createElement('span');
      idBadge.className = 'slot-id-badge';
      idBadge.textContent = `Slot ${slot.id}`;

      const statusBadge = document.createElement('span');
      if (!slot.available) {
        statusBadge.className = 'slot-badge booked';
        statusBadge.textContent = 'Booked';
      } else if (isPast) {
        statusBadge.className = 'slot-badge past';
        statusBadge.textContent = 'Already Started';
      } else {
        statusBadge.className = 'slot-badge available';
        statusBadge.textContent = 'Available';
      }

      topRow.append(idBadge, statusBadge);

      const providerEl = document.createElement('h3');
      providerEl.className = 'slot-provider';
      providerEl.textContent = slot.provider;

      const timeEl = document.createElement('p');
      timeEl.className = 'slot-time';
      timeEl.textContent = formatDateTimeRange(slot.start, slot.end);

      const isoEl = document.createElement('p');
      isoEl.className = 'slot-iso';
      isoEl.textContent = `${slot.start} → ${slot.end}`;

      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className =
        selectedSlotId === slot.id ? 'btn btn-primary btn-block' : 'btn btn-secondary btn-block';
      if (!slot.available) {
        actionBtn.textContent = 'Unavailable (Booked)';
        actionBtn.disabled = true;
      } else if (isPast) {
        actionBtn.textContent = 'Past Slot (Test Only)';
        actionBtn.addEventListener('click', () => selectSlot(slot.id));
      } else {
        actionBtn.textContent =
          selectedSlotId === slot.id ? '✓ Selected for Booking' : 'Select Slot';
        actionBtn.addEventListener('click', () => selectSlot(slot.id));
      }

      card.append(topRow, providerEl, timeEl, isoEl, actionBtn);
      slotsListEl.append(card);
    }
  }

  function updateProviderFilterOptions(slots) {
    const currentVal = providerFilterEl.value;
    for (const s of slots) {
      if (s.provider) knownProviders.add(s.provider);
    }
    providerFilterEl.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Providers';
    providerFilterEl.append(allOpt);

    Array.from(knownProviders)
      .sort()
      .forEach((prov) => {
        const opt = document.createElement('option');
        opt.value = prov;
        opt.textContent = prov;
        providerFilterEl.append(opt);
      });

    if (currentVal && knownProviders.has(currentVal)) {
      providerFilterEl.value = currentVal;
    }
  }

  async function loadSlots() {
    slotsFeedbackEl.textContent = 'Loading slots...';
    const provider = providerFilterEl.value;
    const query = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    const res = await apiFetch(`/slots${query}`, { method: 'GET' });

    if (!res.ok) {
      slotsFeedbackEl.textContent = `Error (${res.status}): ${res.data?.error || 'Could not load slots'}`;
      slotsListEl.replaceChildren();
      return;
    }

    const slots = res.data?.slots || [];
    allSlotsCache = slots;
    if (!provider) {
      knownProviders.clear();
    }
    updateProviderFilterOptions(slots);

    const availableCount = slots.filter((s) => s.available && Date.parse(s.start) > Date.now()).length;
    slotsFeedbackEl.textContent = `Showing ${slots.length} slot(s) (${availableCount} available for booking).`;

    if (!selectedSlotId) {
      const firstAvail = slots.find((s) => s.available && Date.parse(s.start) > Date.now());
      if (firstAvail) {
        selectedSlotId = firstAvail.id;
        slotIdInput.value = firstAvail.id;
      }
    }

    renderSlots(slots);
  }

  // Handle Booking Form Submission (POST /bookings)
  bookingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormAlert();

    if (!bookingForm.checkValidity()) {
      bookingForm.reportValidity();
      return;
    }

    const payload = {
      slot_id: slotIdInput.value.trim(),
      name: patientNameInput.value,
      email: patientEmailInput.value
    };

    const headers = {};
    const idemKey = (idemKeyInput.value || '').trim();
    if (idemKey) {
      headers['Idempotency-Key'] = idemKey;
    }

    bookSubmitBtn.disabled = true;
    bookSubmitBtn.textContent = 'Booking Appointment...';

    try {
      const res = await apiFetch('/bookings', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (res.status === 201 && res.data) {
        showFormAlert(`Appointment confirmed! Booking ID: ${res.data.id}`, 'success');
        renderConfirmation(res.data, true);
        lookupIdInput.value = res.data.id;
        lookupEmailInput.value = res.data.email;
        idemKeyInput.value = generateIdempotencyKey();
        await loadSlots();
      } else {
        const retryAfter = res.headers.get('Retry-After');
        const extra = retryAfter ? ` (Retry-After: ${retryAfter}s)` : '';
        showFormAlert(
          `Booking failed [${res.status}]: ${res.data?.error || 'Request rejected'}${extra}`,
          'error'
        );
      }
    } catch (err) {
      showFormAlert(`Network error: ${err.message}`, 'error');
    } finally {
      bookSubmitBtn.disabled = false;
      bookSubmitBtn.textContent = 'Confirm Appointment Booking';
    }
  });

  // Cancel active booking (DELETE /bookings/{id})
  async function handleCancelBooking() {
    if (!activeBooking || !activeBooking.id) return;
    cancelConfirmedBtn.disabled = true;
    dialogCancelBookingBtn.disabled = true;

    const res = await apiFetch(`/bookings/${encodeURIComponent(activeBooking.id)}`, {
      method: 'DELETE'
    });

    if (res.ok && res.data) {
      renderConfirmation(res.data, false);
      showFormAlert(`Booking ${res.data.id} has been cancelled and slot ${res.data.slot_id} is available again.`, 'success');
      await loadSlots();
    } else {
      showFormAlert(`Cancel failed [${res.status}]: ${res.data?.error || 'Unable to cancel'}`, 'error');
      cancelConfirmedBtn.disabled = activeBooking.status === 'cancelled';
      dialogCancelBookingBtn.disabled = activeBooking.status === 'cancelled';
    }
  }

  cancelConfirmedBtn.addEventListener('click', handleCancelBooking);
  dialogCancelBookingBtn.addEventListener('click', handleCancelBooking);
  viewModalBtn.addEventListener('click', () => {
    if (activeBooking && typeof confirmationDialog.showModal === 'function') {
      confirmationDialog.showModal();
    }
  });

  // Lookup Booking by ID (GET /bookings/{id})
  lookupIdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = lookupIdInput.value.trim();
    if (!id) return;

    const res = await apiFetch(`/bookings/${encodeURIComponent(id)}`, { method: 'GET' });
    if (res.ok && res.data) {
      renderConfirmation(res.data, true);
      clearFormAlert();
    } else {
      showFormAlert(`Lookup [${res.status}]: ${res.data?.error || 'Booking not found'}`, 'error');
    }
  });

  // Paginated Bookings by Email (GET /bookings?email=...&limit=...&cursor=...)
  async function fetchPatientBookingsPage(cursor = null) {
    const email = lookupEmailInput.value.trim();
    if (!email) return;
    const limit = lookupLimitInput.value || '10';
    let url = `/bookings?email=${encodeURIComponent(email)}&limit=${encodeURIComponent(limit)}`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    const res = await apiFetch(url, { method: 'GET' });
    if (!res.ok) {
      showFormAlert(`Search failed [${res.status}]: ${res.data?.error || 'Failed to load bookings'}`, 'error');
      return;
    }

    const bookings = res.data?.bookings || [];
    currentPaginationCursor = res.data?.next_cursor ?? null;
    patientBookingsContainer.hidden = false;
    patientBookingsList.replaceChildren();

    if (bookings.length === 0) {
      const li = document.createElement('li');
      li.className = 'booking-list-item';
      li.textContent = 'No bookings found for this email.';
      patientBookingsList.append(li);
    } else {
      for (const b of bookings) {
        const li = document.createElement('li');
        li.className = 'booking-list-item';

        const info = document.createElement('div');
        info.innerHTML = '';
        const title = document.createElement('strong');
        title.textContent = `${b.id} · Slot ${b.slot_id}`;
        const meta = document.createElement('span');
        meta.textContent = ` (${b.status}) — ${b.created_at}`;
        info.append(title, meta);

        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'btn btn-secondary btn-sm';
        viewBtn.textContent = 'View';
        viewBtn.addEventListener('click', () => renderConfirmation(b, true));

        li.append(info, viewBtn);
        patientBookingsList.append(li);
      }
    }

    cursorStatus.textContent = currentPaginationCursor
      ? `More results available (next_cursor: ${currentPaginationCursor})`
      : 'End of results (next_cursor: null)';
    nextPageBtn.disabled = !currentPaginationCursor;
  }

  lookupEmailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await fetchPatientBookingsPage(null);
  });

  firstPageBtn.addEventListener('click', async () => {
    await fetchPatientBookingsPage(null);
  });

  nextPageBtn.addEventListener('click', async () => {
    if (currentPaginationCursor) {
      await fetchPatientBookingsPage(currentPaginationCursor);
    }
  });

  // Filter & Refresh Slots
  filterForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await loadSlots();
  });

  refreshSlotsBtn.addEventListener('click', async () => {
    await loadSlots();
  });

  newIdemKeyBtn.addEventListener('click', () => {
    idemKeyInput.value = generateIdempotencyKey();
  });

  // Reset Demo Slots (POST /reset)
  resetDemoBtn.addEventListener('click', async () => {
    const demoSlots = [
      { id: 's1', provider: 'Dr Ade', start: '2026-12-10T09:00:00Z', end: '2026-12-10T09:30:00Z' },
      { id: 's2', provider: 'Dr Ade', start: '2026-12-10T09:30:00Z', end: '2026-12-10T10:00:00Z' },
      { id: 's3', provider: 'Dr Bello', start: '2026-12-10T10:00:00Z', end: '2026-12-10T10:30:00Z' },
      { id: 's4', provider: 'Dr Bello', start: '2026-12-10T11:00:00Z', end: '2026-12-10T11:30:00Z' },
      { id: 's5', provider: 'Dr Chen', start: '2026-12-11T14:00:00Z', end: '2026-12-11T14:30:00Z' },
      { id: 's6', provider: 'Dr Chen', start: '2026-12-11T15:00:00Z', end: '2026-12-11T15:30:00Z' }
    ];
    const res = await apiFetch('/reset', {
      method: 'POST',
      body: JSON.stringify({ slots: demoSlots })
    });
    if (res.ok) {
      confirmationCard.hidden = true;
      patientBookingsContainer.hidden = true;
      selectedSlotId = 's1';
      slotIdInput.value = 's1';
      showFormAlert('Demo slots and bookings have been reset via POST /reset.', 'success');
      await loadSlots();
    } else {
      showFormAlert(`Reset failed [${res.status}]: ${res.data?.error || 'Error'}`, 'error');
    }
  });

  // Initialize
  idemKeyInput.value = generateIdempotencyKey();
  loadSlots();
})();
