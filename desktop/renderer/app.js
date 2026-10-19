/* global MicTranscriber */
(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'interview-partner:setup';
  const MIC_KEY = 'interview-partner:mic';

  const state = {
    backendUrl: 'http://127.0.0.1:8787',
    setup: null, // { resume, job_description, role }
    history: [], // [{ role: 'interviewer' | 'candidate', text }]
    busy: false,
    mic: null,
    answerPrefix: '',
  };

  // ---------- helpers ----------

  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: setup just won't be remembered */
    }
  }

  function load(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  function show(view) {
    for (const id of ['setup-view', 'interview-view', 'report-view']) $(id).hidden = id !== view;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(id, text, kind) {
    const node = $(id);
    node.textContent = text;
    node.className = `status${kind ? ' ' + kind : ''}`;
  }

  /** Splits an interviewer reply into its [FEEDBACK] and [QUESTION] sections (works on partial text). */
  function parseInterviewer(text) {
    const q = text.indexOf('[QUESTION]');
    const f = text.indexOf('[FEEDBACK]');
    let feedback = '';
    let question = '';
    if (q === -1) {
      feedback = f === -1 ? '' : text.slice(f + 10);
      if (f === -1) question = text; // no markers yet / model ignored them
    } else {
      feedback = f === -1 || f > q ? '' : text.slice(f + 10, q);
      question = text.slice(q + 10);
    }
    return { feedback: feedback.trim(), question: question.trim() };
  }

  function renderInterviewer(container, text) {
    container.replaceChildren(el('div', 'who', 'Interviewer'));
    const { feedback, question } = parseInterviewer(text);
    if (feedback) {
      const box = el('div', 'feedback');
      const body = el('div', 'feedback-body');
      renderMarkdown(body, feedback);
      box.append(el('div', 'feedback-title', 'Feedback on your answer'), body);
      container.append(box);
    }
    container.append(el('div', 'question', question || '…'));
  }

  function addMessage(role, text) {
    const node = el('div', `msg ${role}`);
    if (role === 'interviewer') renderInterviewer(node, text);
    else node.append(el('div', 'who', role === 'candidate' ? 'You' : 'Error'), el('div', '', text));
    $('log').append(node);
    $('log').scrollTop = $('log').scrollHeight;
    return node;
  }

  /** Minimal, escaped Markdown: headings, bullets, paragraphs, **bold**, *italic*, `code`. */
  function renderMarkdown(target, md) {
    target.replaceChildren();
    let list = null;
    const inline = (parent, line) => {
      line.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).forEach((part) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) parent.append(el('strong', '', part.slice(2, -2)));
        else if (/^`[^`]+`$/.test(part)) parent.append(el('code', '', part.slice(1, -1)));
        else if (/^\*[^*\s][^*]*\*$/.test(part)) parent.append(el('em', '', part.slice(1, -1)));
        else if (part) parent.append(document.createTextNode(part));
      });
    };
    for (const raw of md.split('\n')) {
      const line = raw.trimEnd();
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (bullet) {
        if (!list) target.append((list = el('ul')));
        const li = el('li');
        inline(li, bullet[1]);
        list.append(li);
        continue;
      }
      list = null;
      if (heading) target.append(el(`h${Math.min(heading[1].length, 4)}`, '', heading[2]));
      else if (line.trim()) {
        const p = el('p');
        inline(p, line);
        target.append(p);
      }
    }
  }

  // ---------- backend ----------

  /** Polls /api/health: fast while offline so the app recovers as soon as the backend starts. */
  async function checkBackend() {
    clearTimeout(state.healthTimer);
    let online = false;
    try {
      const res = await fetch(`${state.backendUrl}/api/health`);
      const info = await res.json();
      online = true;
      setStatus('backend-status', info.stt ? 'Backend ready' : 'Backend ready (no voice: type answers)', 'ok');
      if (!(state.mic && state.mic.active)) $('record-btn').disabled = !info.stt;
    } catch {
      setStatus('backend-status', `Backend offline at ${state.backendUrl}. Start it with: python app.py`, 'bad');
      if (!(state.mic && state.mic.active)) $('record-btn').disabled = true;
    }
    $('start-btn').disabled = !online;
    state.healthTimer = setTimeout(checkBackend, online ? 15000 : 3000);
  }

  /** fetch() that turns the browser's bare "Failed to fetch" into an actionable message. */
  async function backendFetch(path, options) {
    try {
      return await fetch(`${state.backendUrl}${path}`, options);
    } catch {
      checkBackend();
      throw new Error(`Can't reach the backend at ${state.backendUrl}. Is it running? (python app.py)`);
    }
  }

  /** Streams /api/chat. onText(fullTextSoFar). Resolves with the full text. */
  async function streamChat(action, onText) {
    const res = await backendFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state.setup, history: state.history, action }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(typeof body.detail === 'string' ? body.detail : `Backend error (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.type === 'text') {
          text += event.text;
          onText(text);
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }
    }
    if (!text.trim()) throw new Error('Empty response from the interviewer.');
    return text;
  }

  // ---------- interview flow ----------

  function setBusy(busy, label) {
    state.busy = busy;
    $('submit-btn').disabled = busy;
    $('end-btn').disabled = busy;
    setStatus('composer-status', label || '');
  }

  function speak(text) {
    if (!$('speak-toggle').checked || !('speechSynthesis' in window) || !text) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  async function interviewerTurn() {
    setBusy(true, 'Interviewer is thinking…');
    const bubble = addMessage('interviewer', '');
    try {
      const text = await streamChat('next', (t) => {
        renderInterviewer(bubble, t);
        $('log').scrollTop = $('log').scrollHeight;
      });
      state.history.push({ role: 'interviewer', text });
      speak(parseInterviewer(text).question);
      setBusy(false, '');
      $('answer-input').focus();
    } catch (err) {
      bubble.remove();
      addMessage('error', err.message);
      setBusy(false, 'Retry with Submit, or end the session.');
    }
  }

  async function startInterview() {
    const setup = {
      resume: $('resume-input').value.trim(),
      job_description: $('jd-input').value.trim(),
      role: $('role-input').value.trim() || null,
    };
    if (!setup.resume || !setup.job_description) {
      $('setup-error').textContent = 'Add both your resume and the job description.';
      return;
    }
    $('setup-error').textContent = '';
    store(STORAGE_KEY, setup);
    state.setup = setup;
    state.history = [];
    $('log').replaceChildren();
    $('answer-input').value = '';
    show('interview-view');
    await interviewerTurn();
  }

  async function submitAnswer() {
    if (state.busy) return;
    if (state.mic && state.mic.active) await toggleRecording();
    const last = state.history[state.history.length - 1];
    // If the last interviewer turn failed, Submit retries it.
    if (!last || last.role === 'candidate') return interviewerTurn();

    const answer = $('answer-input').value.trim();
    if (!answer) {
      setStatus('composer-status', 'Answer first: record or type.');
      return;
    }
    state.history.push({ role: 'candidate', text: answer });
    addMessage('candidate', answer);
    $('answer-input').value = '';
    await interviewerTurn();
  }

  async function endInterview() {
    if (state.busy) return;
    if (state.mic && state.mic.active) await toggleRecording();
    speechSynthesis.cancel();
    const pending = $('answer-input').value.trim();
    const last = state.history[state.history.length - 1];
    if (pending && last && last.role === 'interviewer') state.history.push({ role: 'candidate', text: pending });

    setBusy(true, 'Writing your report…');
    show('report-view');
    const report = $('report');
    report.replaceChildren(el('p', 'status', 'Writing your report…'));
    try {
      await streamChat('report', (t) => renderMarkdown(report, t));
    } catch (err) {
      report.replaceChildren(el('p', 'error', err.message));
    }
    setBusy(false, '');
  }

  async function toggleRecording() {
    const btn = $('record-btn');
    if (state.mic && state.mic.active) {
      btn.disabled = true;
      setStatus('composer-status', 'Finishing transcript…');
      try {
        await state.mic.stop();
      } finally {
        btn.disabled = false;
        btn.classList.remove('recording');
        btn.textContent = '● Record';
        $('mic-select').disabled = false;
        $('mic-level').style.width = '0';
        // Keep a silent-mic warning visible after stopping; otherwise clear "Finishing transcript…".
        setStatus('composer-status', state.micWarning || '', state.micWarning ? 'bad' : undefined);
      }
      return;
    }
    speechSynthesis.cancel();
    state.mic = state.mic || new MicTranscriber(state.backendUrl);
    const existing = $('answer-input').value.trim();
    state.answerPrefix = existing ? existing + ' ' : '';
    btn.disabled = true;
    state.micWarning = false;
    try {
      await state.mic.start(
        (text) => {
          $('answer-input').value = state.answerPrefix + text;
        },
        (err) => {
          setStatus('composer-status', err.message, 'bad');
          if (state.mic.active) toggleRecording();
        },
        {
          deviceId: $('mic-select').value,
          onLevel: (level) => {
            $('mic-level').style.width = `${Math.round(level * 100)}%`;
          },
          onSilent: () => {
            state.micWarning = `No sound from "${state.mic.deviceLabel || 'this microphone'}". Pick another microphone.`;
            setStatus('composer-status', state.micWarning, 'bad');
          },
        },
      );
      btn.classList.add('recording');
      btn.textContent = '■ Stop';
      $('mic-select').disabled = true;
      setStatus('composer-status', `Listening on ${state.mic.deviceLabel || 'microphone'}…`);
      refreshMics(); // labels become available once mic permission is granted
    } catch (err) {
      await state.mic.stop().catch(() => {});
      const missing = err.name === 'OverconstrainedError' || err.name === 'NotFoundError';
      setStatus('composer-status', missing ? 'That microphone is not available. Pick another one.' : err.message, 'bad');
      if (missing) refreshMics();
    } finally {
      btn.disabled = false;
    }
  }

  /** Fills the microphone picker, keeping the saved choice when that device is still present. */
  async function refreshMics() {
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch {
      return;
    }
    const select = $('mic-select');
    const wanted = select.value || load(MIC_KEY) || '';
    const options = [el('option', '', 'System default microphone')];
    options[0].value = '';
    devices
      // "default" and "communications" are Windows aliases for devices already in the list.
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => {
        const option = el('option', '', d.label || `Microphone ${i + 1}`);
        option.value = d.deviceId;
        options.push(option);
      });
    select.replaceChildren(...options);
    select.value = options.some((o) => o.value === wanted) ? wanted : '';
  }

  // ---------- wiring ----------

  async function init() {
    if (window.partner) {
      const config = await window.partner.getConfig();
      state.backendUrl = config.backendUrl;
    }
    const saved = load(STORAGE_KEY);
    if (saved) {
      $('resume-input').value = saved.resume || '';
      $('jd-input').value = saved.job_description || '';
      $('role-input').value = saved.role || '';
    }

    let loadTarget = null;
    document.querySelectorAll('[data-load-into]').forEach((btn) =>
      btn.addEventListener('click', () => {
        loadTarget = btn.dataset.loadInto;
        $('file-picker').value = '';
        $('file-picker').click();
      }),
    );
    $('file-picker').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file && loadTarget) $(loadTarget).value = await file.text();
    });

    $('start-btn').addEventListener('click', startInterview);
    $('submit-btn').addEventListener('click', submitAnswer);
    $('end-btn').addEventListener('click', endInterview);
    $('record-btn').addEventListener('click', toggleRecording);
    $('mic-select').addEventListener('change', (e) => {
      store(MIC_KEY, e.target.value);
      state.micWarning = false;
      setStatus('composer-status', '');
    });
    navigator.mediaDevices.addEventListener('devicechange', refreshMics);
    refreshMics();
    $('restart-btn').addEventListener('click', () => show('setup-view'));
    $('ontop-toggle').addEventListener('change', (e) => window.partner && window.partner.setAlwaysOnTop(e.target.checked));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey && !$('interview-view').hidden) {
        e.preventDefault();
        submitAnswer();
      }
    });

    await checkBackend();
  }

  init();
})();
