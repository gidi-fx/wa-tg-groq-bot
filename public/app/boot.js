    /* =============================== router =============================== */
    // Resolved lazily and defensively: if one page script fails to load, the app
    // must still render instead of throwing a ReferenceError and going blank.
    function resolvePage(path) {
      const map = {
        '/': typeof dashboardPage === 'function' ? dashboardPage : null,
        '/connect': typeof connectPage === 'function' ? connectPage : null,
        '/agents': typeof agentsPage === 'function' ? agentsPage : null,
        '/inbox': typeof inboxPage === 'function' ? inboxPage : null,
        '/groups': typeof groupsPage === 'function' ? groupsPage : null,
        '/playground': typeof playgroundPage === 'function' ? playgroundPage : null,
        '/settings': typeof settingsPage === 'function' ? settingsPage : null,
        '/telegram': typeof telegramPage === 'function' ? telegramPage : null,
      };
      if (map[path]) return map[path];
      if (typeof notFoundPage === 'function') return notFoundPage;
      return null;
    }

    async function render() {
      const path = (location.pathname.replace(/\/+$/, '') || '/');
      const [title, subtitle] = titles[path] || ['Not found', ''];

      try {
        $('#page-title').textContent = title;
        $('#page-subtitle').textContent = subtitle;
        document.title = title + ' · WhatsApp Groq Router v2';
        setActiveNav(path);
        paintPersistenceBanner();
      } catch (error) {
        console.error('[boot] chrome update failed', error);
      }

      if (typeof state.cleanup === 'function') {
        try { state.cleanup(); } catch { /* ignore */ }
        state.cleanup = null;
      }

      const view = $('#view');
      const page = resolvePage(path);
      if (!page) {
        view.innerHTML = offlinePanel(new Error('A page script did not load. Reload to try again.'));
        return;
      }

      view.innerHTML = spinner('Loading');
      try {
        const cleanup = await page(view);
        if (typeof cleanup === 'function') state.cleanup = cleanup;
      } catch (error) {
        console.error('[page] ' + path + ' failed', error);
        view.innerHTML = error.offline ? offlinePanel(error) : errorBox(error);
        const retry = $('#retry-btn', view);
        if (retry) retry.addEventListener('click', render);
      }

      try { paintPersistenceBanner(); } catch { /* ignore */ }
      window.scrollTo({ top: 0, behavior: 'instant' });
    }

    window.addEventListener('popstate', render);

    // A load failure in a <script> tag or an unexpected error must not leave a blank screen.
    window.addEventListener('error', (event) => {
      console.error('[window] error', event.message || event.error);
      const view = $('#view');
      if (view && !view.children.length) view.innerHTML = offlinePanel(event.error || new Error(event.message));
    });

    $('#sidebar-nav').innerHTML = navHTML(false);
    $('#mobile-nav').innerHTML = navHTML(true);
    setTheme(document.documentElement.classList.contains('dark'));
    render().catch((error) => {
      console.error('[boot] render failed', error);
      $('#view').innerHTML = offlinePanel(error);
    });
