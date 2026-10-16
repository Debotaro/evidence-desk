"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    health: null,
    documents: [],
    history: [],
    report: null,
    selectedId: null,
    currentAnswer: null,
    edit: false,
    pendingConfirmation: null,
    queryPending: false,
  };
  const modeLabels = {
    bm25: "BM25 · keyword",
    dense: "MiniLM · semantic",
    hybrid: "Hybrid · MiniLM + BM25",
  };
  let token = "";
  try {
    token = sessionStorage.getItem("evidencedesk-token") || "";
  } catch (_) {
    /* A blocked storage policy still allows this tab to connect. */
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function message(text, kind = "error") {
    const target = $(kind === "error" ? "global-error" : "global-notice");
    target.textContent = text;
    target.hidden = !text;
    if (text)
      $(kind === "error" ? "global-notice" : "global-error").hidden = true;
  }

  function announce(text) {
    $("live-status").textContent = text;
  }

  function detailText(detail) {
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail))
      return detail.map((item) => item.msg || "Invalid input").join("; ");
    return "The server could not complete this request.";
  }

  async function api(path, options = {}) {
    const headers = { Accept: "application/json", ...options.headers };
    if (options.body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers,
        signal: controller.signal,
        credentials: "same-origin",
      });
    } catch (error) {
      throw new Error(
        error.name === "AbortError"
          ? "The request timed out. Check that the server is running and try again."
          : "Cannot reach the workspace. Check the local server, then use Connection to reconnect.",
      );
    } finally {
      clearTimeout(timeout);
    }
    let data;
    try {
      data = await response.json();
    } catch (_) {
      throw new Error(
        "The server returned an unreadable response. Check the server logs, then try again.",
      );
    }
    if (!response.ok) {
      const error = new Error(
        response.status === 401
          ? "Workspace access requires a valid API token. Open Connection to unlock this session."
          : detailText(data.detail),
      );
      error.status = response.status;
      if (response.status === 401) {
        $("connection-state").className = "connection-state failed";
        $("connection-label").textContent = "Access required";
      }
      throw error;
    }
    return data;
  }

  function busy(button, active, activeText) {
    if (active) {
      button.dataset.idleText = button.textContent.trim();
      button.textContent = activeText;
    } else if (button.dataset.idleText) {
      button.textContent = button.dataset.idleText;
      delete button.dataset.idleText;
    }
    button.disabled = active;
    button.setAttribute("aria-busy", String(active));
  }

  function friendlyDate(value, includeTime = false) {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      ...(includeTime ? { timeStyle: "short" } : {}),
    }).format(date);
  }

  function showView(name, focus = false) {
    const valid = ["workbench", "knowledge", "quality"];
    if (!valid.includes(name)) name = "workbench";
    for (const view of valid) $("view-" + view).hidden = view !== name;
    document.querySelectorAll("[data-view]").forEach((link) => {
      const active = link.dataset.view === name;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $("view-name").textContent = name[0].toUpperCase() + name.slice(1);
    document.title = `${$("view-name").textContent} — EvidenceDesk`;
    if (focus) {
      const heading = $(name + "-title");
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }

  function renderHealth() {
    if (!state.health) return;
    $("connection-state").className = "connection-state connected";
    $("connection-label").textContent = state.health.auth_required
      ? "Connected · protected"
      : "Connected · local";
    $("footer-engine").textContent =
      state.health.mode === "hybrid"
        ? "MiniLM embeddings + BM25 · extractive"
        : "BM25 keyword search · extractive";
    const embeddingAvailable = Boolean(state.health.model);
    for (const option of $("search-mode").options) {
      option.disabled = option.value !== "bm25" && !embeddingAvailable;
    }
    if (!embeddingAvailable) $("search-mode").value = "bm25";
    $("connection-description").textContent = state.health.auth_required
      ? "This workspace requires its configured API token. The token stays in this browser tab's session storage and is sent only to this application's API."
      : "This workspace is running in local mode. You can add a token here if your server is configured to require one. It stays in this browser tab's session storage.";
    updateMethodNote();
  }

  function updateMethodNote() {
    const mode = $("search-mode").value;
    $("method-note").textContent =
      mode === "bm25"
        ? "BM25 searches matching terms. Answers quote source passages; no generative model is used."
        : mode === "dense"
          ? "Local MiniLM embeddings retrieve related passages. Answers are extractive; no generative model is used."
          : "Local MiniLM embeddings and BM25 combine semantic and keyword retrieval. Answers are extractive.";
  }

  function renderCounts() {
    const count = state.documents.length;
    const chunks = state.documents.reduce(
      (total, doc) => total + (Number(doc.chunk_count) || 0),
      0,
    );
    ["nav-doc-count", "sidebar-doc-count", "knowledge-doc-count"].forEach(
      (id) => {
        $(id).textContent = String(count);
      },
    );
    ["sidebar-chunk-count", "knowledge-chunk-count"].forEach((id) => {
      $(id).textContent = String(chunks);
    });
    $("start-description").textContent = count
      ? `Your library has ${count} ${count === 1 ? "document" : "documents"}. Ask a specific question above to retrieve supporting passages.`
      : "Add a document to begin, or explore with five fictional merchant support policies.";
    $("start-heading").textContent = count
      ? "Your sources are ready."
      : "Good answers leave a trail.";
    $("seed-button").hidden = count > 0;
    document.querySelector(".empty-footnote").hidden = count > 0;
    $("starter-section").hidden = !count;
    $("starter-section").querySelector(".section-label").textContent =
      "FICTIONAL EXAMPLE QUESTIONS";
  }

  function renderHistory() {
    const list = $("history-list");
    list.replaceChildren();
    $("clear-history").hidden = !state.history.length;
    if (!state.history.length) {
      list.append(
        element(
          "p",
          "muted empty-history",
          "Your questions will appear here. A record of what you checked.",
        ),
      );
      return;
    }
    state.history.forEach((query) => {
      const button = element("button", "history-item");
      button.type = "button";
      button.append(element("span", "history-question", query.question));
      const meta = element("span", "history-meta");
      meta.append(
        element(
          "span",
          `history-status ${query.status === "abstained" ? "abstained" : ""}`,
          query.status === "answered" ? "Evidence found" : "Abstained",
        ),
        element("span", "", friendlyDate(query.created_at)),
      );
      button.append(meta);
      button.addEventListener("click", () => {
        if (state.queryPending) return;
        $("question").value = query.question;
        renderAnswer(query);
        location.hash = "workbench";
        announce(
          "Previous answer loaded. This is a saved result, not a new search.",
        );
      });
      list.append(button);
    });
  }

  function renderAnswer(result) {
    state.currentAnswer = result;
    $("workbench-empty").hidden = true;
    $("answer-panel").hidden = false;
    const answered = result.status === "answered";
    $("answer-heading").textContent = answered
      ? "Source-backed answer"
      : "The evidence is not enough";
    $("answer-status").className =
      `tag ${answered ? "tag-green" : "tag-amber"}`;
    $("answer-status").textContent = answered ? "Evidence found" : "Abstained";
    $("answer-question").textContent = result.question;
    $("answer-text").textContent =
      result.answer || "No supported answer was found in the current library.";
    $("answer-reason").textContent = result.reason || "";
    $("answer-reason").hidden = !result.reason;
    $("answer-method").textContent =
      `${modeLabels[result.mode] || result.mode || "Local retrieval"} · extractive`;
    $("answer-latency").textContent = Number.isFinite(result.latency_ms)
      ? `${Math.round(result.latency_ms).toLocaleString()} ms · server retrieval`
      : "";
    const citations = Array.isArray(result.citations) ? result.citations : [];
    $("citation-count").textContent = String(citations.length);
    $("citation-list").replaceChildren();
    if (!citations.length)
      $("citation-list").append(
        element(
          "p",
          "no-citations",
          "No source passages meet the evidence threshold. Try a more specific question or add a relevant document.",
        ),
      );
    citations.forEach((citation, index) => {
      const card = element("article", "citation-card");
      const heading = element("div", "citation-heading");
      const sourceButton = element("button", "citation-title", citation.title);
      sourceButton.type = "button";
      sourceButton.setAttribute(
        "aria-label",
        `Read source document: ${citation.title}`,
      );
      sourceButton.addEventListener("click", () => {
        if (!state.documents.some((doc) => doc.id === citation.document_id)) {
          message(
            "This source is no longer in the library. Refresh the workspace to see its current state.",
          );
          return;
        }
        state.selectedId = citation.document_id;
        state.edit = false;
        renderDocuments();
        renderInspector();
        location.hash = "knowledge";
      });
      heading.append(
        element("span", "citation-number", String(index + 1).padStart(2, "0")),
        sourceButton,
        element("span", "tag tag-neutral", `v${citation.version}`),
      );
      card.append(heading, element("blockquote", "", citation.text));
      const meta = element("div", "citation-metadata");
      meta.append(element("span", "", `Passage ${citation.chunk_id}`));
      if (Number.isFinite(citation.score))
        meta.append(
          element("span", "", `Retrieval score ${citation.score.toFixed(3)}`),
        );
      card.append(meta);
      $("citation-list").append(card);
    });
    if (citations.length)
      $("citation-list").append(
        element(
          "p",
          "citation-note",
          "Retrieval scores rank relevance within this search. They are not confidence probabilities. Inspect the source before acting.",
        ),
      );
  }

  function renderDocuments() {
    const query = $("document-filter").value.toLocaleLowerCase().trim();
    const filtered = state.documents.filter((doc) =>
      doc.title.toLocaleLowerCase().includes(query),
    );
    $("filter-count").textContent = String(filtered.length);
    $("document-list").replaceChildren();
    if (!filtered.length) {
      $("document-list").append(
        element(
          "p",
          "document-empty",
          state.documents.length
            ? "No matching documents. Try another title."
            : "Your library is empty. Add a plain text or Markdown document to start searching.",
        ),
      );
      return;
    }
    filtered.forEach((doc) => {
      const button = element(
        "button",
        `document-item ${state.selectedId === doc.id ? "selected" : ""}`,
      );
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.selectedId === doc.id));
      const icon = element("span", "document-icon", "≡");
      icon.setAttribute("aria-hidden", "true");
      const body = element("span", "document-item-body");
      body.append(
        element("span", "document-item-title", doc.title),
        element(
          "span",
          "document-item-meta",
          `Version ${doc.version} · ${doc.chunk_count} ${doc.chunk_count === 1 ? "passage" : "passages"}`,
        ),
        element(
          "span",
          "document-item-meta",
          `Updated ${friendlyDate(doc.updated_at)}`,
        ),
      );
      button.append(icon, body);
      button.addEventListener("click", () => {
        state.selectedId = doc.id;
        state.edit = false;
        renderDocuments();
        renderInspector();
      });
      $("document-list").append(button);
    });
  }

  function renderInspector() {
    const panel = $("document-inspector");
    panel.replaceChildren();
    const doc = state.documents.find((item) => item.id === state.selectedId);
    if (!doc) {
      const empty = element("div", "inspector-empty");
      empty.append(
        element("span", "", "↳"),
        element("h2", "", "Know your sources."),
        element(
          "p",
          "",
          "Select a document to read its content, inspect its version, or make an edit.",
        ),
      );
      panel.append(empty);
      return;
    }
    const header = element("div", "inspector-header");
    const titleBlock = element("div");
    titleBlock.append(
      element("span", "section-label", "SOURCE DOCUMENT"),
      element("h2", "", doc.title),
    );
    const meta = element("div", "inspector-meta");
    meta.append(
      element("span", "tag tag-green", `Version ${doc.version}`),
      element(
        "span",
        "",
        `${doc.chunk_count} indexed ${doc.chunk_count === 1 ? "passage" : "passages"}`,
      ),
    );
    titleBlock.append(meta);
    header.append(titleBlock);
    if (!state.edit) {
      const actions = element("div", "inspector-actions");
      const edit = element("button", "button button-secondary", "Edit source");
      edit.type = "button";
      edit.addEventListener("click", () => {
        state.edit = true;
        renderInspector();
        $("edit-content").focus();
      });
      const remove = element("button", "button button-danger-quiet", "Delete");
      remove.type = "button";
      remove.setAttribute("aria-label", `Delete document: ${doc.title}`);
      remove.addEventListener("click", () =>
        confirmAction(
          "Delete this document?",
          `“${doc.title}” and its indexed passages will be removed. Saved questions that reference this document will also be deleted.`,
          "Delete document",
          async () => {
            await api(`/api/documents/${encodeURIComponent(doc.id)}`, {
              method: "DELETE",
            });
            state.selectedId = null;
            state.currentAnswer = null;
            $("answer-panel").hidden = true;
            $("workbench-empty").hidden = false;
            await refreshWorkspace();
            message(
              "Document deleted. Related saved questions have been removed.",
              "notice",
            );
          },
        ),
      );
      actions.append(edit, remove);
      header.append(actions);
    }
    panel.append(header);
    if (state.edit) {
      const form = element("form");
      form.id = "edit-document-form";
      const label = element("label", "edit-label", "Edit source content");
      label.htmlFor = "edit-content";
      const input = element("textarea", "edit-textarea");
      input.id = "edit-content";
      input.value = doc.content;
      input.maxLength = 50000;
      input.required = true;
      const error = element("p", "form-error");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const footer = element("div", "edit-footer");
      const buttons = element("div");
      const cancel = element("button", "button button-secondary", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        state.edit = false;
        renderInspector();
      });
      const save = element(
        "button",
        "button button-primary",
        "Save new version",
      );
      save.type = "submit";
      buttons.append(cancel, save);
      footer.append(
        element(
          "span",
          "",
          `Editing version ${doc.version}. Changes are checked for conflicts.`,
        ),
        buttons,
      );
      form.append(label, input, error, footer);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!input.value.trim()) {
          error.textContent = "Add source text before saving.";
          error.hidden = false;
          return;
        }
        busy(save, true, "Saving…");
        error.hidden = true;
        try {
          const updated = await api(
            `/api/documents/${encodeURIComponent(doc.id)}`,
            {
              method: "PUT",
              body: JSON.stringify({
                content: input.value,
                expected_version: doc.version,
              }),
            },
          );
          state.edit = false;
          state.currentAnswer = null;
          $("answer-panel").hidden = true;
          $("workbench-empty").hidden = false;
          await refreshWorkspace();
          message(
            `Saved ${doc.title}, version ${updated.version}.${redactionNotice(updated)}`,
            "notice",
          );
        } catch (issue) {
          error.textContent =
            issue.status === 409
              ? `${issue.message} Your edits are still here. Copy them, then reload this page to compare with the latest version.`
              : issue.message;
          error.hidden = false;
        } finally {
          busy(save, false);
        }
      });
      panel.append(form);
    } else panel.append(element("pre", "document-content", doc.content));
    const provenance = element("details", "document-provenance");
    provenance.append(element("summary", "", "Document provenance"));
    const data = element("dl");
    [
      ["Document ID", doc.id],
      ["Created", friendlyDate(doc.created_at, true)],
      ["Updated", friendlyDate(doc.updated_at, true)],
      ["SHA-256", doc.sha256],
    ].forEach(([key, value]) => {
      data.append(
        element("dt", "", key),
        element("dd", "", value || "Unavailable"),
      );
    });
    provenance.append(data);
    panel.append(provenance);
  }

  function redactionNotice(doc) {
    const count = Number(doc.redactions) || 0;
    return count
      ? ` ${count} obvious personal-information ${count === 1 ? "pattern was" : "patterns were"} redacted.`
      : "";
  }

  function metric(value, percent = false) {
    if (!Number.isFinite(value)) return "—";
    return percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(1);
  }

  function renderEvaluation() {
    const panel = $("evaluation-report");
    panel.replaceChildren();
    const report = state.report;
    if (
      !report ||
      report.status !== "complete" ||
      !Array.isArray(report.modes) ||
      !report.modes.length
    ) {
      const empty = element("section", "evaluation-empty");
      empty.append(
        element("h2", "", "Measured results belong here."),
        element(
          "p",
          "",
          "No completed evaluation report is available. Run the evaluation command in the repository, then refresh this page.",
        ),
        element(
          "p",
          "",
          "The checked-in README documents the exact command and dataset. This view only reads the resulting report; it does not run evaluations.",
        ),
      );
      panel.append(empty);
      return;
    }
    const header = element("div", "evaluation-header");
    const intro = element("div");
    const referenceCases = report.modes[0].results || [];
    const holdoutCases = referenceCases.filter(
      (item) => item.split === "holdout",
    ).length;
    const developmentCases = referenceCases.filter(
      (item) => item.split === "development",
    ).length;
    intro.append(
      element("h2", "", "Retrieval comparison"),
      element(
        "p",
        "",
        `${report.dataset || "Dataset unavailable"} · ${report.cases ?? "?"} total cases · ${report.corpus_documents ?? "?"} source documents`,
      ),
      element(
        "p",
        "",
        `Report generated ${friendlyDate(report.generated_at, true)}`,
      ),
    );
    if (holdoutCases)
      intro.append(
        element(
          "p",
          "",
          `Metrics below: ${holdoutCases} holdout cases. ${developmentCases} development checks are listed separately in the case details.`,
        ),
      );
    header.append(intro, element("span", "tag tag-green", "Recorded results"));
    panel.append(header);
    const wrap = element("div", "evaluation-table-wrap");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute(
      "aria-label",
      "Evaluation metrics, scroll horizontally for all columns",
    );
    const table = element("table", "evaluation-table");
    const caption = element(
      "caption",
      "visually-hidden",
      "Retrieval metrics on the fictional holdout dataset",
    );
    const head = element("thead");
    const heading = element("tr");
    [
      "Method",
      "Recall @ 3",
      "MRR",
      "Abstention accuracy",
      "Citation integrity",
      "p50 latency",
      "p95 latency",
    ].forEach((text) => {
      const cell = element("th", "", text);
      cell.scope = "col";
      heading.append(cell);
    });
    head.append(heading);
    const body = element("tbody");
    report.modes.forEach((mode) => {
      const row = element("tr");
      const label = element("th", "", modeLabels[mode.mode] || mode.mode);
      label.scope = "row";
      row.append(
        label,
        element("td", "", metric(mode.recall_at_3, true)),
        element(
          "td",
          "",
          Number.isFinite(mode.mrr) ? mode.mrr.toFixed(3) : "—",
        ),
        element("td", "", metric(mode.abstention_accuracy, true)),
        element("td", "", metric(mode.citation_integrity, true)),
        element("td", "", `${metric(mode.latency_p50_ms)} ms`),
        element("td", "", `${metric(mode.latency_p95_ms)} ms`),
      );
      body.append(row);
    });
    table.append(caption, head, body);
    wrap.append(table);
    panel.append(wrap);
    const definitions = element("div", "metric-definitions");
    [
      [
        "Recall @ 3",
        "Share of answerable cases whose expected document appears among the first three retrieved sources.",
      ],
      [
        "Mean reciprocal rank",
        "Rewards the expected document appearing earlier. A score of 1 means it ranked first for every answerable case.",
      ],
      [
        "Abstention & integrity",
        "Abstention measures refusing unsupported cases. Citation integrity checks that cited text belongs to the recorded source.",
      ],
    ].forEach(([title, text]) => {
      const card = element("div");
      card.append(element("h3", "", title), element("p", "", text));
      definitions.append(card);
    });
    panel.append(definitions);
    if (report.note) panel.append(element("p", "evaluation-note", report.note));
    if (report.model)
      panel.append(
        element(
          "p",
          "evaluation-note",
          `Embedding model: ${report.model}. Local timing depends on hardware and model cache state.`,
        ),
      );
    report.modes.forEach((mode) => {
      if (!Array.isArray(mode.results) || !mode.results.length) return;
      const details = element("details", "case-details");
      details.append(
        element(
          "summary",
          "",
          `${modeLabels[mode.mode] || mode.mode} — inspect ${mode.results.length} cases`,
        ),
      );
      mode.results.forEach((result) => {
        const row = element("article", "case-row");
        const heading = element("div", "case-heading");
        const expectedAbstention = result.expected_document === null;
        const pass = expectedAbstention
          ? result.status === "abstained"
          : result.hit;
        heading.append(
          element("h3", "", result.question),
          element(
            "span",
            `tag ${pass ? "tag-green" : "tag-amber"}`,
            expectedAbstention
              ? pass
                ? "Abstained"
                : "Answered"
              : result.hit
                ? `Retrieved · rank ${result.rank}`
                : "Missed",
          ),
        );
        row.append(
          heading,
          element(
            "p",
            "",
            `Case ${result.id} · ${result.split || "split unavailable"} · expected source: ${result.expected_document || "none (unsupported)"} · ${metric(result.latency_ms)} ms`,
          ),
        );
        details.append(row);
      });
      panel.append(details);
    });
  }

  async function refreshWorkspace() {
    const [documents, history] = await Promise.all([
      api("/api/documents"),
      api("/api/history"),
    ]);
    state.documents = documents.documents || [];
    state.history = history.queries || [];
    if (!state.documents.some((doc) => doc.id === state.selectedId))
      state.selectedId = null;
    renderCounts();
    renderDocuments();
    renderInspector();
    renderHistory();
  }

  async function loadEvaluation() {
    state.report = await api("/api/evaluations");
    renderEvaluation();
  }

  function openDocumentDialog() {
    $("document-form").reset();
    $("document-form-error").hidden = true;
    $("content-length").textContent = "0 / 50,000";
    $("document-dialog").showModal();
    $("document-title").focus();
  }

  function openConnectionDialog() {
    $("api-token").value = token;
    $("connection-error").hidden = true;
    $("connection-dialog").showModal();
    $("api-token").focus();
  }

  function confirmAction(title, description, action, callback) {
    state.pendingConfirmation = callback;
    $("confirm-title").textContent = title;
    $("confirm-description").textContent = description;
    $("confirm-submit").textContent = action;
    $("confirm-dialog").showModal();
    $("confirm-dialog").querySelector(".modal-footer .close-dialog").focus();
  }

  async function connect() {
    state.health = await api("/api/health");
    renderHealth();
    await refreshWorkspace();
    try {
      await loadEvaluation();
    } catch (issue) {
      state.report = null;
      renderEvaluation();
      message(
        `Sources connected. Evaluation report could not be loaded: ${issue.message}`,
      );
    }
  }

  $("query-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.queryPending) return;
    const question = $("question").value.trim();
    if (!question) {
      $("question").focus();
      message("Enter a question to search your documents.");
      return;
    }
    message("");
    $("global-notice").hidden = true;
    state.queryPending = true;
    busy($("query-submit"), true, "Searching…");
    $("query-loading").hidden = false;
    $("answer-panel").hidden = true;
    $("workbench-empty").hidden = true;
    try {
      const result = await api("/api/query", {
        method: "POST",
        body: JSON.stringify({
          question,
          mode: $("search-mode").value,
          top_k: 3,
        }),
      });
      renderAnswer(result);
      announce(
        result.status === "answered"
          ? `Answer found with ${result.citations.length} source passages.`
          : "The search abstained because there was not enough evidence.",
      );
      try {
        state.history = (await api("/api/history")).queries || [];
        renderHistory();
      } catch (issue) {
        message(
          `Search completed, but history could not refresh: ${issue.message}`,
        );
      }
    } catch (issue) {
      message(
        issue.status === 503
          ? `${issue.message} Select BM25 keyword search to continue without the embedding model.`
          : issue.message,
      );
      if (state.currentAnswer) renderAnswer(state.currentAnswer);
      else $("workbench-empty").hidden = false;
    } finally {
      state.queryPending = false;
      busy($("query-submit"), false);
      $("query-loading").hidden = true;
    }
  });

  $("search-mode").addEventListener("change", updateMethodNote);
  $("question").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $("query-form").requestSubmit();
    }
  });
  document.querySelectorAll(".starter-question").forEach((button) =>
    button.addEventListener("click", () => {
      $("question").value = button.dataset.question;
      $("question").focus();
    }),
  );
  $("seed-button").addEventListener("click", async () => {
    const button = $("seed-button");
    busy(button, true, "Loading fictional policies…");
    try {
      const response = await api("/api/seed", { method: "POST" });
      await refreshWorkspace();
      message(
        `Fictional example library ready. ${response.added} ${response.added === 1 ? "document" : "documents"} added. These policies are synthetic.`,
        "notice",
      );
      $("question").focus();
    } catch (issue) {
      message(issue.message);
    } finally {
      busy(button, false);
    }
  });
  $("add-document").addEventListener("click", openDocumentDialog);
  $("add-from-sidebar").addEventListener("click", openDocumentDialog);
  $("document-content").addEventListener("input", () => {
    $("content-length").textContent =
      `${$("document-content").value.length.toLocaleString()} / 50,000`;
  });
  $("document-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = $("document-title").value.trim();
    const content = $("document-content").value;
    if (!title || !content.trim()) {
      $("document-form-error").textContent =
        "Add a title and source text before saving.";
      $("document-form-error").hidden = false;
      return;
    }
    busy($("save-document"), true, "Adding…");
    $("document-form-error").hidden = true;
    try {
      const result = await api("/api/documents", {
        method: "POST",
        body: JSON.stringify({ title, content }),
      });
      state.selectedId = result.id;
      state.edit = false;
      await refreshWorkspace();
      $("document-dialog").close();
      location.hash = "knowledge";
      message(
        `${result.created === false ? "Already in your library:" : "Added to your library:"} ${result.title || title}.${redactionNotice(result)}`,
        "notice",
      );
    } catch (issue) {
      $("document-form-error").textContent = issue.message;
      $("document-form-error").hidden = false;
    } finally {
      busy($("save-document"), false);
    }
  });
  $("document-filter").addEventListener("input", renderDocuments);
  $("connection-button").addEventListener("click", openConnectionDialog);
  $("connection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const previousToken = token;
    token = $("api-token").value.trim();
    busy($("connect-submit"), true, "Connecting…");
    $("connection-error").hidden = true;
    try {
      await connect();
      try {
        if (token) sessionStorage.setItem("evidencedesk-token", token);
        else sessionStorage.removeItem("evidencedesk-token");
      } catch (_) {
        /* Continue with the in-memory token when storage is unavailable. */
      }
      $("connection-dialog").close();
      message("Workspace connected.", "notice");
    } catch (issue) {
      token = previousToken;
      $("connection-error").textContent = issue.message;
      $("connection-error").hidden = false;
    } finally {
      busy($("connect-submit"), false);
    }
  });
  $("clear-history").addEventListener("click", () =>
    confirmAction(
      "Clear saved questions?",
      "All saved questions and answers in this workspace will be deleted. Your source documents will stay in the library.",
      "Clear history",
      async () => {
        const result = await api("/api/history", { method: "DELETE" });
        state.history = [];
        renderHistory();
        message(
          `Cleared ${result.deleted} saved ${result.deleted === 1 ? "question" : "questions"}.`,
          "notice",
        );
      },
    ),
  );
  $("confirm-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.pendingConfirmation) return;
    busy($("confirm-submit"), true, "Deleting…");
    try {
      await state.pendingConfirmation();
      $("confirm-dialog").close();
      state.pendingConfirmation = null;
    } catch (issue) {
      $("confirm-dialog").close();
      message(issue.message);
    } finally {
      busy($("confirm-submit"), false);
    }
  });
  document
    .querySelectorAll(".close-dialog")
    .forEach((button) =>
      button.addEventListener("click", () => button.closest("dialog").close()),
    );
  $("refresh-quality").addEventListener("click", async () => {
    busy($("refresh-quality"), true, "Refreshing…");
    try {
      await loadEvaluation();
      announce("Evaluation report refreshed.");
    } catch (issue) {
      message(issue.message);
    } finally {
      busy($("refresh-quality"), false);
    }
  });
  window.addEventListener("hashchange", () =>
    showView(location.hash.slice(1), true),
  );
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    $("main-content").focus();
    $("main-content").scrollIntoView({ block: "start" });
  });
  showView(location.hash.slice(1));
  renderEvaluation();
  connect().catch((issue) => {
    message(issue.message);
    $("connection-state").className = "connection-state failed";
    $("connection-label").textContent =
      issue.status === 401 ? "Access required" : "Disconnected";
    if (issue.status === 401) openConnectionDialog();
  });
})();
