import {
      supabase,
      isSupabaseConfigured,
      currentUser,
      authHeaders,
      signInWithGoogle,
      signInWithPassword,
      signUpWithPassword,
      signOut,
      isEmbeddedPreview
    } from './supabase-client.js?v=20260727';

    const $ = selector => document.querySelector(selector);
    const $$ = selector => [...document.querySelectorAll(selector)];
    const escapeHtml = value => String(value ?? '').replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
    const safeExternalUrl = value => {
      try {
        const url = new URL(String(value || ''));
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
      } catch (_) {
        return '';
      }
    };
    // Every /api/* endpoint always responds with JSON on every path — but
    // an unhandled crash in one (timeout, network blip reaching a
    // third-party API) can still make the platform return an empty or
    // non-JSON body. response.json() on that throws "Unexpected end of
    // JSON input", meaningless to show someone mid-task.
    async function safeJson(response) {
      try {
        return await response.json();
      } catch (_) {
        return { error: 'Something went wrong. Please try again.' };
      }
    }
    const safeTags = value => String(value || '')
      .split(',')
      .map(tag => tag.trim().toLowerCase().replace(/[^a-z0-9 +#.-]/g, ''))
      .filter(Boolean)
      .slice(0, 8);
    const PROJECT_IMAGE_PREFIX = '__image__:';
    const PROJECT_LINK_PREFIX = '__link__:';
    const MAX_PROJECT_QUESTIONS = 8;
    const PROJECT_LOCATION_PREFIX = '__location__:';
    const APPLICATIONS_PAUSED_TAG = '__applications_paused__';
    const isAcceptingApplications = project =>
      project?.status === 'open' && !(project?.tags || []).includes(APPLICATIONS_PAUSED_TAG);
    const projectTags = project => (project?.tags || [])
      .filter(tag =>
        !String(tag).startsWith(PROJECT_IMAGE_PREFIX) &&
        !String(tag).startsWith(PROJECT_LINK_PREFIX) &&
        !String(tag).startsWith(PROJECT_LOCATION_PREFIX) &&
        String(tag) !== APPLICATIONS_PAUSED_TAG
      );
    const projectImageData = project => {
      const marker = (project?.tags || []).find(tag => String(tag).startsWith(PROJECT_IMAGE_PREFIX));
      return marker ? String(marker).slice(PROJECT_IMAGE_PREFIX.length) : '';
    };
    const projectLinks = project => (project?.tags || [])
      .filter(tag => String(tag).startsWith(PROJECT_LINK_PREFIX))
      .map(tag => {
        try {
          const [label, url] = JSON.parse(String(tag).slice(PROJECT_LINK_PREFIX.length));
          const safeUrl = safeExternalUrl(url);
          return safeUrl ? { label: String(label || 'Project link').slice(0, 40), url: safeUrl } : null;
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .slice(0, 6);
    const projectLinkIconMarkup = link => {
      let isGitHub = false;
      try {
        isGitHub = new URL(link.url).hostname.toLowerCase().replace(/^www\./, '') === 'github.com';
      } catch (_) {
        isGitHub = false;
      }
      if (!isGitHub && !/github/i.test(link.label || '')) return '';
      return `<svg class="project-link-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.24c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.29-5.27-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.16 1.18a10.96 10.96 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.41-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.2c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z"/>
      </svg>`;
    };
    const projectLinkMarkup = project => projectLinks(project).map(link => `
      <a class="project-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">
        <span class="project-link-label">
          ${projectLinkIconMarkup(link)}
          <span>${escapeHtml(link.label)}</span>
        </span>
        <span aria-hidden="true">↗</span>
      </a>
    `).join('');
    const projectCardTagsMarkup = project => {
      const tags = projectTags(project);
      return [
        ...tags.slice(0, 2).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`),
        ...(tags.length > 2 ? [`<span class="tag tag-more">+${tags.length - 2}</span>`] : [])
      ].join('');
    };
    // seats_total is the static capacity set at creation — it never moved
    // as people were actually accepted, so a project with every seat
    // filled looked identical to one with none. seatCounts (populated from
    // the public_team_connections-style project_seat_counts() RPC) is the
    // real count of accepted applications per project.
    const seatsLabel = project => {
      const total = Number(project?.seats_total) || 0;
      if (!total) return '';
      const filled = seatCounts.get(String(project.id)) || 0;
      // A bare "3/5 seats" makes someone stop and work out which number is
      // which — spelling it out reads correctly on first glance whether
      // you're the owner checking progress or an applicant checking
      // whether there's room left.
      if (filled >= total) return `All ${total} ${total === 1 ? 'seat' : 'seats'} filled`;
      return `${filled} of ${total} ${total === 1 ? 'seat' : 'seats'} filled`;
    };
    // profiles.location_* columns are the single source of truth for a
    // member's shared location. An earlier version also mirrored this into
    // auth user_metadata and into a hidden tag on every owned project —
    // three copies that could (and did) drift out of sync on a partial
    // failure. Reading straight from the loaded profile row here removes
    // that whole class of bug.
    const profileLocation = profileRow => {
      // Number.isFinite (no coercion) on purpose: Number(null) is 0, a
      // real-looking coordinate, so a coerced check would treat "no
      // location saved" as "shared at 0°,0°".
      const latitude = profileRow?.location_latitude;
      const longitude = profileRow?.location_longitude;
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 ||
        longitude < -180 || longitude > 180
      ) return null;
      return {
        shared: true,
        label: String(profileRow?.location_label || '').trim().slice(0, 100),
        latitude,
        longitude
      };
    };
    const fileToDataUrl = file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('The selected image could not be read.'));
      reader.readAsDataURL(file);
    });
    const canvasToBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

    async function optimizeProjectImage(file) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new Error('Choose a JPEG, PNG, or WebP image.');
      }
      if (file.size > 8 * 1024 * 1024) throw new Error('Images must be 8 MB or smaller.');
      const bitmap = await createImageBitmap(file);
      const maxWidth = 1440;
      const maxHeight = 960;
      const baseScale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      const byteLimit = 180 * 1024;
      let smallest = null;
      for (const dimensionScale of [1, .82, .68]) {
        canvas.width = Math.max(1, Math.round(bitmap.width * baseScale * dimensionScale));
        canvas.height = Math.max(1, Math.round(bitmap.height * baseScale * dimensionScale));
        context.fillStyle = '#171717';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const quality of [.82, .68, .54]) {
          const blob = await canvasToBlob(canvas, 'image/webp', quality)
            || await canvasToBlob(canvas, 'image/jpeg', quality);
          if (!blob) continue;
          smallest = !smallest || blob.size < smallest.size ? blob : smallest;
          if (blob.size <= byteLimit) {
            bitmap.close?.();
            return `${PROJECT_IMAGE_PREFIX}${await fileToDataUrl(blob)}`;
          }
        }
      }
      bitmap.close?.();
      if (smallest && smallest.size <= 260 * 1024) {
        return `${PROJECT_IMAGE_PREFIX}${await fileToDataUrl(smallest)}`;
      }
      throw new Error('This image could not be optimized enough. Try a simpler or smaller image.');
    }

    const previewProjects = [
      {
        id: 'preview-mindweave',
        title: 'Mindweave',
        summary: 'A voice-first journal for people who do not enjoy journaling.',
        description: 'Preview example: a humane reflection product seeking mobile engineering and product design.',
        tags: ['engineering', 'design', 'mobile'],
        status: 'open',
        owner: 'Preview project',
        boost_until: null
      },
      {
        id: 'preview-nestmate',
        title: 'Nestmate',
        summary: 'A local support network designed around the realities of new parenthood.',
        description: 'Preview example: a community product exploring trust, safety, and useful neighborhood connection.',
        tags: ['design', 'research', 'community'],
        status: 'open',
        owner: 'Preview project',
        boost_until: null
      },
      {
        id: 'preview-pulseboard',
        title: 'Pulseboard',
        summary: 'A focused status page for independent product teams.',
        description: 'Preview example: a small developer tool seeking infrastructure and documentation collaborators.',
        tags: ['engineering', 'research'],
        status: 'open',
        owner: 'Preview project',
        boost_until: null
      }
    ];

    let projects = [];
    let seatCounts = new Map();
    let activeFilter = 'all';
    let activeProject = null;
    let authMode = 'signin';

    function toast(message) {
      const element = $('#toast');
      element.textContent = message;
      element.classList.add('show');
      window.clearTimeout(toast.timer);
      toast.timer = window.setTimeout(() => element.classList.remove('show'), 3200);
    }

    let activeModal = null;
    let modalReturnFocus = null;
    const modalBackground = [document.querySelector('header'), document.querySelector('main'), $('#preview-note')].filter(Boolean);
    const visibleFocusable = modal => [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.type !== 'hidden' && !element.closest('[hidden]') && element.offsetParent !== null);

    function openModal(name) {
      const modal = $(`#modal-${name}`);
      window.clearTimeout(modal.closeTimer);
      modal.classList.remove('closing');
      modalReturnFocus = document.activeElement;
      activeModal = modal;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      modalBackground.forEach(region => region.inert = true);
      document.body.classList.add('modal-open');
      window.requestAnimationFrame(() => {
        const target = visibleFocusable(modal)[0];
        (target || modal).focus();
      });
    }

    function replaceModal(name, nextName) {
      const modal = $(`#modal-${name}`);
      const returnTarget = modalReturnFocus;
      window.clearTimeout(modal.closeTimer);
      modal.classList.remove('open', 'closing');
      modal.setAttribute('aria-hidden', 'true');
      activeModal = null;
      openModal(nextName);
      modalReturnFocus = returnTarget;
    }

    function closeModal(name) {
      const modal = $(`#modal-${name}`);
      if (!modal.classList.contains('open')) return;
      const returnTarget = modalReturnFocus;
      const finish = () => {
        modal.classList.remove('open', 'closing');
        modal.setAttribute('aria-hidden', 'true');
        modalBackground.forEach(region => region.inert = false);
        document.body.classList.remove('modal-open');
        if (activeModal === modal) activeModal = null;
        if (returnTarget && document.contains(returnTarget)) returnTarget.focus();
        modalReturnFocus = null;
      };
      if (reducedMotion) {
        finish();
        return;
      }
      modal.classList.add('closing');
      modal.closeTimer = window.setTimeout(finish, 170);
    }

    document.addEventListener('keydown', event => {
      if (!activeModal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal(activeModal.id.replace('modal-', ''));
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = visibleFocusable(activeModal);
      if (!focusable.length) {
        event.preventDefault();
        activeModal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    let accountUser = null;
    let accountProfile = null;
    async function refreshAccount() {
      const user = await currentUser();
      accountUser = user;
      accountProfile = null;
      const button = $('#account-button');
      const avatar = $('#account-avatar');
      const avatarImg = $('#account-avatar-img');
      const avatarInitial = $('#account-avatar-initial');
      const label = $('#account-label');
      if (user) {
        const displayName = user.user_metadata?.full_name
          || user.user_metadata?.name
          || user.user_metadata?.display_name
          || user.email
          || 'Account';
        const initial = String(displayName).trim().charAt(0) || 'A';
        // profiles.avatar_url is the source of truth once a member uploads
        // their own photo in the Profile tab — the auth metadata photo
        // (Google's picture) is only a fallback for before that happens.
        // Fetched alongside location here so initLocationInvite() doesn't
        // need a second round trip just to check location_latitude.
        if (isSupabaseConfigured) {
          const { data } = await supabase.from('profiles')
            .select('avatar_url,location_label,location_latitude,location_longitude')
            .eq('id', user.id)
            .maybeSingle();
          accountProfile = data || null;
        }
        const profileAvatarUrl = String(accountProfile?.avatar_url || '').trim();
        const avatarUrl = profileAvatarUrl || String(user.user_metadata?.avatar_url || user.user_metadata?.picture || '').trim();
        avatarInitial.textContent = initial;
        avatarImg.referrerPolicy = 'no-referrer';
        avatarImg.onerror = () => {
          avatarImg.hidden = true;
          avatarInitial.hidden = false;
        };
        if (avatarUrl) {
          avatarImg.src = avatarUrl;
          avatarImg.alt = `${displayName} profile photo`;
          avatarImg.hidden = false;
          avatarInitial.hidden = true;
        } else {
          avatarImg.hidden = true;
          avatarImg.removeAttribute('src');
          avatarInitial.hidden = false;
        }
        avatar.hidden = false;
        label.textContent = 'Account';
        button.classList.add('account-signed-in');
        button.setAttribute('aria-label', `Open ${displayName}'s profile`);
        button.title = displayName;
        button.dataset.open = '';
        button.onclick = () => { window.location.href = 'project-hub.html'; };
      } else {
        avatarImg.hidden = true;
        avatarImg.removeAttribute('src');
        avatarInitial.hidden = true;
        avatarInitial.textContent = '';
        avatar.hidden = true;
        label.textContent = 'Sign in';
        button.classList.remove('account-signed-in');
        button.setAttribute('aria-label', 'Sign in');
        button.removeAttribute('title');
        button.dataset.open = 'auth';
        button.onclick = () => openModal('auth');
      }
      initLocationInvite();
      return user;
    }

    async function loadProjects() {
      const board = $('#project-pins');
      board.setAttribute('aria-busy', 'true');
      board.innerHTML = '<span class="sr-only">Loading projects</span><div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div>';
      if (!isSupabaseConfigured) {
        projects = previewProjects;
        $('#preview-note').hidden = false;
        renderProjectFilters();
        renderProjects();
        board.setAttribute('aria-busy', 'false');
        return;
      }

      try {
        const { data, error } = await supabase
          .from('projects')
          .select('id,title,summary,description,tags,status,seats_total,boost_until,owner_id,profiles:owner_id(display_name)')
          .neq('status', 'closed')
          .order('boost_until', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false });

        if (error) throw error;
        projects = (data || []).map(project => ({
          ...project,
          owner: project.profiles?.display_name || 'connectEd member'
        }));

        const { data: seatData } = await supabase.rpc('project_seat_counts');
        seatCounts = new Map((seatData || []).map(row => [String(row.project_id), Number(row.accepted_count) || 0]));
        renderProjectFilters();
        renderProjects();
      } catch (error) {
        projects = [];
        board.innerHTML = '<div class="empty">Projects could not be loaded. <button class="btn btn-small" id="retry-projects" type="button">Retry</button></div>';
        $('#retry-projects').onclick = loadProjects;
        const resultSummary = $('#landing-results-summary');
        if (resultSummary) resultSummary.textContent = 'Projects unavailable';
        toast('Projects could not be loaded.');
      } finally {
        board.setAttribute('aria-busy', 'false');
      }
    }

    function renderProjects() {
      const query = $('#nav-search').value.toLowerCase().trim();
      const filtered = projects.filter(project => {
        const visibleTags = projectTags(project);
        const matchesFilter = activeFilter === 'all' || visibleTags.includes(activeFilter);
        const haystack = [
          project.title,
          project.summary,
          project.description,
          project.owner,
          ...visibleTags
        ].join(' ').toLowerCase();
        return matchesFilter && (!query || haystack.includes(query));
      });
      const resultSummary = $('#landing-results-summary');
      if (resultSummary) {
        resultSummary.textContent = `${filtered.length} ${filtered.length === 1 ? 'project' : 'projects'} shown`;
      }

      $('#project-pins').innerHTML = filtered.length
        ? filtered.map((project, index) => {
            const boosted = project.boost_until && new Date(project.boost_until) > new Date();
            // Was missing the paused-applications check entirely (unlike
            // project-hub.js's equivalent pinMarkup()) — a project with
            // applications explicitly paused by its owner still showed
            // "Open project" here, with nothing distinguishing it from one
            // actually accepting applicants.
            const acceptingApplications = isAcceptingApplications(project);
            const statusClass = boosted
              ? 'is-boosted'
              : !acceptingApplications && project.status === 'open'
              ? 'is-paused'
              : project.status === 'invite_only'
              ? 'is-invite'
              : 'is-open';
            const statusLabel = boosted
              ? 'Boosted idea'
              : !acceptingApplications && project.status === 'open'
              ? 'Applications paused'
              : project.status === 'invite_only'
              ? 'Invite only'
              : 'Open project';
            const seatLabel = seatsLabel(project);
            const seatSuffix = seatLabel ? ` · ${seatLabel}` : '';
            return `
              <article class="pin glass" data-od-id="project-card-${escapeHtml(project.id)}">
                <div class="pin-cover">
                  <img class="pin-thumb" src="${escapeHtml(projectImageData(project) || projectCover(project))}" alt="" loading="lazy" decoding="async"
                    data-fallback-cover="${escapeHtml(projectCover(project))}">
                  <span class="pin-status ${statusClass}">${statusLabel}</span>
                </div>
                <div class="pin-body">
                  <h3 class="pin-title">${escapeHtml(project.title)}</h3>
                  <p>${escapeHtml(project.summary)}</p>
                  <div class="tags">
                    ${projectCardTagsMarkup(project)}
                  </div>
                  <div class="pin-foot">
                    <span class="owner">${escapeHtml(`By ${project.owner}${seatSuffix}`)}</span>
                    <button class="btn btn-small" data-project="${escapeHtml(project.id)}" aria-label="View ${escapeHtml(project.title)}">View project</button>
                  </div>
                </div>
              </article>
            `;
          }).join('')
        : `<div class="empty">
            <p>${query || activeFilter !== 'all'
              ? 'No projects match the current search and filters.'
              : 'No open projects have been shared yet.'}</p>
            <button class="btn btn-small" id="${query || activeFilter !== 'all' ? 'clear-project-view' : 'share-empty-project'}" type="button">
              ${query || activeFilter !== 'all' ? 'Clear search and filters' : 'Share a project'}
            </button>
          </div>`;

      $$('[data-project]').forEach(button => {
        button.onclick = () => showProject(button.dataset.project);
      });
      // An inline onerror="..." attribute here would need script-src
      // 'unsafe-inline' in the CSP just for this one fallback; binding it
      // as a real listener after insertion means the CSP doesn't have to
      // trust arbitrary inline script at all.
      $$('.pin-thumb[data-fallback-cover]').forEach(img => {
        img.onerror = () => {
          img.onerror = null;
          img.src = img.dataset.fallbackCover;
        };
      });
      const clearView = $('#clear-project-view');
      if (clearView) {
        clearView.onclick = () => {
          activeFilter = 'all';
          $('#nav-search').value = '';
          $('#mobile-project-search').value = '';
          $$('[data-filter]').forEach(item => {
            const selected = item.dataset.filter === 'all';
            item.classList.toggle('active', selected);
            item.setAttribute('aria-pressed', String(selected));
          });
          renderProjects();
          const searchTarget = $('#mobile-project-search').offsetParent
            ? $('#mobile-project-search')
            : $('#nav-search');
          searchTarget.focus();
        };
      }
      const shareEmpty = $('#share-empty-project');
      if (shareEmpty) shareEmpty.onclick = () => openModal('create');
      animateProjectCards();
    }

    function renderProjectFilters() {
      const counts = new Map();
      projects.forEach(project => {
        new Set(projectTags(project)).forEach(tag => {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        });
      });
      // Most-used tags first, capped so one-off tags don't crowd the row;
      // short tags read as acronyms (AI, CAD), longer ones as words.
      const tags = [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag]) => tag)
        .slice(0, 5);
      const filterLabel = tag => tag.length <= 3
        ? tag.toUpperCase()
        : tag.charAt(0).toUpperCase() + tag.slice(1);
      if (activeFilter !== 'all' && !tags.includes(activeFilter)) activeFilter = 'all';
      $('#landing-project-filters').innerHTML = [
        `<button class="chip${activeFilter === 'all' ? ' active' : ''}" data-filter="all" aria-pressed="${activeFilter === 'all'}">All ideas</button>`,
        ...tags.map(tag => `
          <button class="chip${activeFilter === tag ? ' active' : ''}" data-filter="${escapeHtml(tag)}" aria-pressed="${activeFilter === tag}">
            ${escapeHtml(filterLabel(tag))}
          </button>
        `)
      ].join('');
      $$('[data-filter]').forEach(button => {
        button.onclick = () => {
          activeFilter = button.dataset.filter;
          renderProjectFilters();
          renderProjects();
        };
      });
    }

    function projectCover(project) {
      const tags = projectTags(project).map(tag => String(tag).toLowerCase());
      if (tags.includes('education')) return 'assets/project-cover-education.png';
      if (tags.includes('community')) return 'assets/project-cover-community.png';
      if (tags.includes('design')) return 'assets/project-cover-design.png';
      if (tags.includes('engineering')) return 'assets/project-cover-engineering.png';
      if (tags.includes('research')) return 'assets/project-cover-research.png';
      return 'assets/project-cover-general.png';
    }

    function animateProjectCards() {
      if (reducedMotion) return;
      $$('#project-pins .pin').slice(0, 6).forEach((card, index) => {
        card.animate(
          [
            { opacity: .35, transform: 'translateY(8px)' },
            { opacity: 1, transform: 'translateY(0)' }
          ],
          {
            duration: 180,
            delay: index * 24,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
            fill: 'both'
          }
        );
      });
    }

    async function showProject(id) {
      activeProject = projects.find(project => String(project.id) === id);
      if (!activeProject) return;
      const requestedProjectId = String(activeProject.id);
      $('#project-title').textContent = activeProject.title;
      const detailSeatLabel = seatsLabel(activeProject);
      $('#project-owner').textContent = `Shared by ${activeProject.owner}${detailSeatLabel ? ` · ${detailSeatLabel}` : ''}`;
      const detailCover = $('#project-detail-cover');
      const fallbackCover = projectCover(activeProject);
      detailCover.onerror = () => {
        detailCover.onerror = null;
        detailCover.src = fallbackCover;
      };
      detailCover.src = projectImageData(activeProject) || fallbackCover;
      detailCover.alt = `${activeProject.title} project cover`;
      detailCover.hidden = false;
      $('#project-description').textContent = activeProject.description;
      $('#project-description').scrollTop = 0;
      $('#project-tags').innerHTML = projectTags(activeProject)
        .map(tag => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join('');
      $('#project-links').innerHTML = projectLinkMarkup(activeProject);
      $('#project-links').hidden = !projectLinks(activeProject).length;

      const questionContainer = $('#project-questions');
      const submitButton = $('#join-form [type="submit"]');
      questionContainer.setAttribute('aria-busy', 'true');
      questionContainer.innerHTML = '<p class="muted">Loading application questions…</p>';
      if (submitButton) submitButton.disabled = true;
      openModal('project');
      let questions = [];
      let questionError = null;
      let viewer = null;
      let existingApplication = null;
      if (isSupabaseConfigured && !id.startsWith('preview-')) {
        viewer = await currentUser();
        const [questionResult, applicationResult] = await Promise.all([
          supabase
            .from('project_questions')
            .select('id,prompt,required,position')
            .eq('project_id', id)
            .order('position'),
          viewer
            ? supabase
                .from('applications')
                .select('id,status')
                .eq('project_id', id)
                .eq('applicant_id', viewer.id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null })
        ]);
        questionError = questionResult.error;
        questions = questionError ? [] : questionResult.data || [];
        existingApplication = applicationResult.error ? null : applicationResult.data;
      }
      if (!activeProject || String(activeProject.id) !== requestedProjectId) return;
      const applicationState = $('#landing-application-state');
      const canApply = activeProject.owner_id !== viewer?.id
        && isAcceptingApplications(activeProject)
        && !existingApplication;
      $$('#join-form .application-fields').forEach(section => {
        section.hidden = !canApply;
      });
      if (!canApply) {
        applicationState.textContent = existingApplication
          ? `You already applied to this project. Current status: ${String(existingApplication.status).replace('_', ' ')}.`
          : activeProject.owner_id === viewer?.id
            ? 'You own this project.'
            : 'This project is not accepting applications right now.';
        applicationState.hidden = false;
      } else {
        applicationState.hidden = true;
      }
      activeProject.questions = questions;
      questionContainer.removeAttribute('aria-busy');
      if (questionError) {
        questionContainer.innerHTML = '<p class="muted">Application questions could not be loaded.</p><button class="btn btn-small" type="button" data-retry-questions>Retry</button>';
        const retry = questionContainer.querySelector('[data-retry-questions]');
        if (retry) retry.onclick = () => showProject(requestedProjectId);
        if (submitButton) submitButton.disabled = true;
        return;
      }
      questionContainer.innerHTML = questions.length ? questions.map(question => `
        <label>
          ${escapeHtml(question.prompt)}
          <textarea class="field" name="question-${escapeHtml(question.id)}"
            rows="3" maxlength="2000" ${question.required ? 'required' : ''}></textarea>
        </label>
      `).join('') : '<p class="muted">No additional questions for this project.</p>';
      if (submitButton) submitButton.disabled = !canApply;
    }

    // Clicking a node opens the published projects of everyone pinned there
    // — a member can own several projects, and a node can represent several
    // members sharing one spot, so this can't just jump into one apply form.
    function showMemberProjects(node) {
      const projectCard = project => {
        const seatLabel = seatsLabel(project);
        const cover = escapeHtml(projectImageData(project) || projectCover(project));
        return `
          <article class="member-project-item">
            <img class="member-project-cover" src="${cover}" alt="" loading="lazy" decoding="async">
            <div class="member-project-info">
              <h3>${escapeHtml(project.title)}</h3>
              <p>${escapeHtml(project.summary)}</p>
              <div class="tags">${projectTags(project).slice(0, 3).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
            </div>
            <div class="member-project-foot">
              ${seatLabel ? `<span class="owner">${escapeHtml(seatLabel)}</span>` : ''}
              <button class="btn btn-primary btn-small" data-apply-project="${escapeHtml(project.id)}">Apply</button>
            </div>
          </article>
        `;
      };
      // Every member who shared a location gets listed here, project or
      // not — a member with nothing published yet used to get the whole
      // node silenced behind a toast, which made them effectively
      // invisible even though they showed up fine as a dot.
      const members = node.members.map(member => ({
        member,
        projects: member.projectIds.map(id => projects.find(project => String(project.id) === id)).filter(Boolean)
      }));
      $('#member-projects-name').textContent = node.cluster ? node.meta.split(' · ')[0] : node.name;
      $('#member-projects-list').innerHTML = members.map(({ member, projects: memberProjects }) => {
        const heading = node.cluster ? `<h4 class="member-project-group">${escapeHtml(member.name)}</h4>` : '';
        if (!memberProjects.length) {
          return `${heading}<p class="member-no-projects">${member.headline ? `${escapeHtml(member.headline)} · ` : ''}Hasn't published a project yet.</p>`;
        }
        return `${heading}${memberProjects.map(projectCard).join('')}`;
      }).join('');
      $$('[data-apply-project]').forEach(button => {
        button.onclick = () => {
          closeModal('member-projects');
          showProject(button.dataset.applyProject);
        };
      });
      openModal('member-projects');
    }

    async function createProject(form) {
      const user = await currentUser();
      if (!user) {
        closeModal('create');
        openModal('auth');
        toast('Sign in before sharing a project.');
        return;
      }
      const values = new FormData(form);
      const image = values.get('image');
      const tags = safeTags(values.get('tags'));
      if (image instanceof File && image.size) tags.push(await optimizeProjectImage(image));
      const { data, error } = await supabase.from('projects').insert({
        owner_id: user.id,
        title: String(values.get('title')).trim(),
        summary: String(values.get('summary')).trim(),
        description: String(values.get('description')).trim(),
        tags,
        seats_total: Number(values.get('seats')),
        status: 'open'
      }).select('id').single();
      if (error) return toast(error.message);

      const newQuestions = values.getAll('question')
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .slice(0, MAX_PROJECT_QUESTIONS);
      if (newQuestions.length) {
        const questionResults = await Promise.all(newQuestions.map((prompt, position) =>
          supabase.from('project_questions').insert({ project_id: data.id, prompt, position, required: true })
        ));
        const questionError = questionResults.find(item => item.error)?.error;
        if (questionError) return toast(questionError.message);
      }

      form.reset();
      resetProjectImagePreview();
      $('#question-list').innerHTML = questionRowMarkup();
      bindQuestionRowButtons();
      closeModal('create');
      toast('Your project is live.');
      await loadProjects();
    }

    function resetProjectImagePreview() {
      const preview = $('#create-image-preview');
      const image = $('#create-image-preview-img');
      if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
      image.removeAttribute('src');
      image.dataset.objectUrl = '';
      preview.hidden = true;
    }

    $('#create-project-image').onchange = event => {
      resetProjectImagePreview();
      const file = event.target.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
        event.target.value = '';
        toast('Choose a JPEG, PNG, or WebP image up to 8 MB.');
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      $('#create-image-preview-img').src = objectUrl;
      $('#create-image-preview-img').dataset.objectUrl = objectUrl;
      $('#create-image-preview').hidden = false;
    };

    async function submitApplication(form) {
      const user = await currentUser();
      if (!user) {
        replaceModal('project', 'auth');
        toast('Sign in before applying.');
        return;
      }
      if (!activeProject || String(activeProject.id).startsWith('preview-')) {
        return toast('Preview projects do not accept applications.');
      }
      if (activeProject.owner_id === user.id) return toast('You already own this project.');
      // The database enforces these same conditions via a row-level security
      // policy, which is the right place to enforce them — but an insert it
      // rejects surfaces as a raw "new row violates row-level security
      // policy" error with no explanation. Check them here first so a
      // paused or closed project gives an answer instead of a stack trace.
      if (!isAcceptingApplications(activeProject)) {
        return toast(
          activeProject.status !== 'open'
            ? 'This project is no longer accepting applications.'
            : 'This project has paused new applications for now.'
        );
      }

      const values = new FormData(form);
      const answers = {};
      for (const question of activeProject.questions || []) {
        answers[question.id] = String(values.get(`question-${question.id}`) || '').trim();
      }
      const note = String(values.get('message') || '').trim();
      if (note && note.length < 20) {
        return toast('Optional notes must be at least 20 characters, or left blank.');
      }
      const { error } = await supabase.from('applications').insert({
        project_id: activeProject.id,
        applicant_id: user.id,
        message: note || 'No additional note provided.',
        answers
      });
      if (error) {
        if (error.code === '23505') return toast('You already applied to this project.');
        if (error.code === '42501' || /row-level security/i.test(error.message || '')) {
          return toast('This application could not be sent — the project may no longer be accepting applications.');
        }
        return toast(error.message);
      }
      form.reset();
      closeModal('project');
      toast('Application sent to the project owner.');
    }

    async function refreshPaymentsStatus() {
      const button = $('#plus-checkout');
      try {
        const response = await fetch('/api/payments-status');
        const data = await response.json();
        button.disabled = !data.configured;
        button.textContent = data.configured ? 'Get connectEd Plus' : 'connectEd Plus — coming soon';
      } catch (_) {
        button.disabled = true;
        button.textContent = 'connectEd Plus — coming soon';
      }
    }

    async function startCheckout() {
      const button = $('#plus-checkout');
      if (button.disabled) return;
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Opening checkout…';
      try {
        const user = await currentUser();
        if (!user) {
          openModal('auth');
          toast('Sign in before starting connectEd Plus.');
          return;
        }
        const response = await fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ plan: 'connected_plus' })
        });
        const data = await safeJson(response);
        if (!response.ok) throw new Error(data.error || 'Checkout is unavailable.');
        window.location.href = data.url;
      } catch (error) {
        toast(error.message || 'Checkout is unavailable.');
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }

    function setAuthMode(mode) {
      authMode = mode;
      const signup = mode === 'signup';
      $('#name-field').hidden = !signup;
      $('#auth-title').textContent = signup ? 'Create your account' : 'Sign in to continue';
      $('#email-auth').textContent = signup ? 'Create account' : 'Sign in';
      $('#auth-mode').textContent = signup
        ? 'Already have an account? Sign in'
        : 'New here? Create an account';
      $('#auth-form [name=password]').autocomplete = signup ? 'new-password' : 'current-password';
    }

    $('#auth-form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = $('#email-auth');
      const originalLabel = submit.textContent;
      form.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      submit.textContent = authMode === 'signup' ? 'Creating…' : 'Signing in…';
      const values = new FormData(form);
      try {
        const result = authMode === 'signup'
          ? await signUpWithPassword(
              String(values.get('email')).trim(),
              String(values.get('password')),
              String(values.get('name')).trim()
            )
          : await signInWithPassword(
              String(values.get('email')).trim(),
              String(values.get('password'))
            );
        if (result.error) throw result.error;
        closeModal('auth');
        toast(authMode === 'signup' ? 'Check your email to confirm your account.' : 'Signed in.');
        await refreshAccount();
      } catch (error) {
        toast(error.message);
      } finally {
        form.setAttribute('aria-busy', 'false');
        submit.disabled = false;
        submit.textContent = originalLabel;
      }
    };

    $('#google-auth').onclick = async event => {
      const button = event.currentTarget;
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Connecting…';
      try {
        const result = await signInWithGoogle('/project-hub.html');
        if (result.previewHandoff) {
          toast('Google needs a full browser tab, so sign-in continues on the live site. In this preview, use email and password instead.');
        }
      } catch (error) {
        toast(error.message || 'Google sign-in is unavailable.');
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    };
    $('#auth-mode').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
    function bindAsyncForm(selector, handler, pendingLabel) {
      const form = $(selector);
      // The browser blocks the 'submit' event entirely when a required field
      // (e.g. a dynamically added application question below the fold) is
      // empty, and fires 'invalid' on that field instead — with only a native
      // tooltip to show for it, which is easy to miss in a scrolling modal
      // and invisible to headless testing. Surface it with a toast too, and
      // debounce so several simultaneously-invalid fields still show one.
      let invalidToastQueued = false;
      form.addEventListener('invalid', event => {
        event.target.classList.add('field-invalid');
        if (invalidToastQueued) return;
        invalidToastQueued = true;
        window.setTimeout(() => {
          invalidToastQueued = false;
          toast('Please fill out the highlighted field before submitting.');
        }, 0);
      }, true);
      form.addEventListener('input', event => event.target.classList.remove('field-invalid'));
      form.onsubmit = async event => {
        event.preventDefault();
        const submit = form.querySelector('[type="submit"]');
        const originalLabel = submit?.textContent;
        form.setAttribute('aria-busy', 'true');
        if (submit) {
          submit.disabled = true;
          submit.textContent = pendingLabel;
        }
        try {
          await handler(form);
        } catch (error) {
          // A SyntaxError here means some response.json() call choked on an
          // empty/non-JSON body (a serverless function crashing before it
          // could send its usual JSON reply) — its .message is literally
          // "Unexpected end of JSON input", meaningless to show mid-task.
          toast(error instanceof SyntaxError
            ? 'Something went wrong on our end. Please try again.'
            : (error.message || 'Something went wrong. Please try again.'));
        } finally {
          form.setAttribute('aria-busy', 'false');
          if (submit) {
            submit.disabled = false;
            submit.textContent = originalLabel;
          }
        }
      };
    }
    function questionRowMarkup() {
      return `
        <div class="question-row">
          <input class="field" name="question" maxlength="500" placeholder="Ask applicants something, or leave this blank">
          <button class="btn btn-small remove-question" type="button" aria-label="Remove question">×</button>
        </div>
      `;
    }
    function bindQuestionRowButtons() {
      const rows = $$('#question-list .question-row');
      rows.forEach(row => {
        const button = row.querySelector('.remove-question');
        button.hidden = rows.length <= 1;
        button.onclick = () => {
          row.remove();
          bindQuestionRowButtons();
        };
      });
    }
    bindQuestionRowButtons();
    $('#add-question').onclick = () => {
      const list = $('#question-list');
      if (list.children.length >= MAX_PROJECT_QUESTIONS) {
        return toast(`Up to ${MAX_PROJECT_QUESTIONS} questions per project.`);
      }
      list.insertAdjacentHTML('beforeend', questionRowMarkup());
      bindQuestionRowButtons();
    };
    bindAsyncForm('#create-form', createProject, 'Publishing…');
    bindAsyncForm('#join-form', submitApplication, 'Sending…');
    $('#plus-checkout').onclick = startCheckout;
    // Disabled until refreshPaymentsStatus() confirms Stripe is actually
    // configured — a visitor clicking mid-setup would otherwise reach
    // create-checkout-session's 503 and see a raw "not configured" error.
    $('#plus-checkout').disabled = true;
    refreshPaymentsStatus();
    const projectSearchInputs = [$('#nav-search'), $('#mobile-project-search')];
    let hadSearchQuery = false;
    projectSearchInputs.forEach(input => {
      input.oninput = () => {
        projectSearchInputs.forEach(peer => {
          if (peer !== input) peer.value = input.value;
        });
        renderProjects();
        // Jump to the board the moment someone starts typing — the search
        // box lives in the header above the hero/globe, so without this the
        // filtered results render off-screen and look like nothing happened.
        const hasQuery = Boolean(input.value.trim());
        if (hasQuery && !hadSearchQuery) {
          $('#discover')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
        }
        hadSearchQuery = hasQuery;
      };
    });

    $$('[data-open]:not(#account-button)').forEach(button => {
      if (button.dataset.open) button.addEventListener('click', () => openModal(button.dataset.open));
    });

    const navBurger = $('#nav-burger');
    const navActions = $('#nav-actions');
    if (navBurger && navActions) {
      const closeNavMenu = () => {
        navActions.classList.remove('open');
        navBurger.setAttribute('aria-expanded', 'false');
      };
      navBurger.addEventListener('click', () => {
        const open = navActions.classList.toggle('open');
        navBurger.setAttribute('aria-expanded', String(open));
      });
      // Tapping any actual action (sign in, browse projects) should close
      // the menu behind it rather than leaving it hanging open.
      navActions.querySelectorAll('a, button').forEach(control => {
        control.addEventListener('click', closeNavMenu);
      });
      document.addEventListener('click', event => {
        if (!navActions.classList.contains('open')) return;
        if (navActions.contains(event.target) || navBurger.contains(event.target)) return;
        closeNavMenu();
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeNavMenu();
      });
    }
    $$('[data-close]').forEach(button => {
      button.onclick = () => closeModal(button.dataset.close);
    });
    $$('.modal-backdrop').forEach(backdrop => {
      backdrop.onclick = event => {
        if (event.target === backdrop) closeModal(backdrop.id.replace('modal-', ''));
      };
    });

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function initMotionSystem() {
      if (reducedMotion) return;
      document.documentElement.classList.add('motion-capable');
      const targets = [...$$('main > section:not(.hero)'), $('footer')].filter(Boolean);
      const revealObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('section-visible');
          revealObserver.unobserve(entry.target);
        });
      }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
      targets.forEach(target => revealObserver.observe(target));
    }

    initMotionSystem();

    async function initProjectNetwork() {
      const stage = $('#stage');
      const canvas = $('#project-network-canvas');
      const focus = $('#network-focus');
      const motionToggle = $('#network-motion-toggle');
      if (!stage || !canvas) return;

      const legendToggle = $('#network-legend-toggle');
      const legend = $('#network-legend');
      if (legendToggle && legend) {
        const closeLegend = () => {
          legend.hidden = true;
          legendToggle.setAttribute('aria-expanded', 'false');
        };
        legendToggle.onclick = event => {
          event.stopPropagation();
          const opening = legend.hidden;
          legend.hidden = !opening;
          legendToggle.setAttribute('aria-expanded', String(opening));
        };
        document.addEventListener('click', event => {
          if (!legend.hidden && !legend.contains(event.target) && event.target !== legendToggle) closeLegend();
        });
        document.addEventListener('keydown', event => {
          if (event.key === 'Escape' && !legend.hidden) closeLegend();
        });
      }

      const openProjects = projects.filter(project => project.status !== 'closed');
      const heroMeta = $('#hero-live-meta');
      if (heroMeta) {
        heroMeta.textContent = openProjects.length
          ? `${openProjects.length} open ${openProjects.length === 1 ? 'project' : 'projects'} on the live board`
          : 'Live board · share the first project';
      }

      // Earth nodes are members who opted into sharing a location, not
      // projects — reflects who's actually on the map, and lets hovering a
      // node surface what that person is building.
      let memberLocations = [];
      if (isSupabaseConfigured) {
        const { data, error } = await supabase
          .from('profiles')
          .select('id,display_name,headline,location_label,location_latitude,location_longitude')
          .not('location_latitude', 'is', null)
          .not('location_longitude', 'is', null)
          .limit(200);
        if (!error) memberLocations = data || [];
      }
      const projectsByOwner = new Map();
      openProjects.forEach(project => {
        if (!projectsByOwner.has(project.owner_id)) projectsByOwner.set(project.owner_id, []);
        projectsByOwner.get(project.owner_id).push(project);
      });

      const defaultFocusMarkup = memberLocations.length
        ? `Live member network<span>Drag to explore. Pinch or two-finger scroll to zoom. Hover a node to see ${memberLocations.length} ${memberLocations.length === 1 ? 'member' : 'members'} and the projects they're building.</span>`
        : 'Live member network<span>Drag to explore. Pinch or two-finger scroll to zoom. Share your location from your profile to place the first node.</span>';
      focus.innerHTML = defaultFocusMarkup;

      try {
        const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.168.0/build/three.module.js');
        const styles = getComputedStyle(document.documentElement);
        const color = token => styles.getPropertyValue(token).trim();
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
        camera.position.set(0, 0, 6.65);

        const renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance'
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor(0, 0);

        const earth = new THREE.Group();
        earth.rotation.set(.12, -1.9, -.12);
        earth.position.set(.48, 0, 0);
        scene.add(earth);

        scene.add(new THREE.AmbientLight(color('--fg'), .62));
        const keyLight = new THREE.DirectionalLight(color('--accent'), 1.7);
        keyLight.position.set(-4, 3, 6);
        scene.add(keyLight);
        const rimLight = new THREE.DirectionalLight(color('--fg-2'), .9);
        rimLight.position.set(4, -2, 2);
        scene.add(rimLight);

        const globeRadius = 2.42;
        const globeGeometry = new THREE.SphereGeometry(globeRadius, 72, 54);
        const globeSurface = new THREE.Mesh(
          globeGeometry,
          new THREE.MeshStandardMaterial({
            color: color('--surface'),
            roughness: .92,
            metalness: 0
          })
        );
        earth.add(globeSurface);

        // Fresnel halo — emerald rim light that follows the camera, replacing
        // the flat translucent shell.
        const atmosphere = new THREE.Mesh(
          new THREE.SphereGeometry(globeRadius + .55, 72, 54),
          new THREE.ShaderMaterial({
            transparent: true,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            uniforms: {
              glowColor: { value: new THREE.Color(color('--accent')) }
            },
            vertexShader: `
              varying vec3 vNormal;
              void main() {
                vNormal = normalize(normalMatrix * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
              }
            `,
            fragmentShader: `
              uniform vec3 glowColor;
              varying vec3 vNormal;
              void main() {
                float intensity = pow(0.66 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.2);
                gl_FragColor = vec4(glowColor, 1.0) * max(intensity, 0.0) * 0.68;
              }
            `
          })
        );
        earth.add(atmosphere);

        function latLonToVector(latitude, longitude, radius = globeRadius + .025) {
          const lat = THREE.MathUtils.degToRad(latitude);
          const lon = THREE.MathUtils.degToRad(longitude);
          return new THREE.Vector3(
            radius * Math.cos(lat) * Math.sin(lon),
            radius * Math.sin(lat),
            radius * Math.cos(lat) * Math.cos(lon)
          );
        }

        const gridMaterial = new THREE.LineBasicMaterial({
          color: color('--fg-2'),
          transparent: true,
          opacity: .12
        });
        [-60, -30, 0, 30, 60].forEach(latitude => {
          const points = [];
          for (let longitude = -180; longitude <= 180; longitude += 4) {
            points.push(latLonToVector(latitude, longitude, globeRadius + .012));
          }
          earth.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            gridMaterial
          ));
        });
        for (let longitude = -150; longitude <= 180; longitude += 30) {
          const points = [];
          for (let latitude = -88; latitude <= 88; latitude += 4) {
            points.push(latLonToVector(latitude, longitude, globeRadius + .012));
          }
          earth.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            gridMaterial
          ));
        }

        // Dot-matrix landmasses: fibonacci-sample the sphere, keep points that
        // fall on land. Land comes from Natural Earth 110m coastlines,
        // rasterized once into a 0.25-degree mask; the stylized hulls below
        // are only the offline fallback.
        const continentShapes = [
          [[-168, 71], [-140, 60], [-125, 49], [-117, 32], [-98, 18], [-82, 25], [-65, 45], [-82, 59], [-108, 72], [-140, 70], [-168, 71]],
          [[-81, 12], [-66, 9], [-51, -5], [-42, -23], [-57, -55], [-72, -40], [-79, -10], [-81, 12]],
          [[-17, 36], [2, 51], [30, 60], [42, 44], [52, 31], [44, 12], [36, -35], [17, -34], [5, -5], [-17, 15], [-17, 36]],
          [[30, 60], [62, 72], [112, 70], [150, 58], [162, 45], [138, 35], [121, 22], [104, 4], [78, 9], [61, 28], [42, 44], [30, 60]],
          [[112, -11], [153, -10], [154, -38], [131, -44], [113, -28], [112, -11]],
          [[-53, 83], [-22, 78], [-18, 63], [-43, 58], [-61, 70], [-53, 83]]
        ];
        function pointInShape(latitude, longitude, shape) {
          let inside = false;
          for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
            const [lonA, latA] = shape[i];
            const [lonB, latB] = shape[j];
            if (
              (latA > latitude) !== (latB > latitude) &&
              longitude < ((lonB - lonA) * (latitude - latA)) / (latB - latA) + lonA
            ) inside = !inside;
          }
          return inside;
        }
        let isLand = (latitude, longitude) =>
          continentShapes.some(shape => pointInShape(latitude, longitude, shape));
        try {
          const [{ feature }, world] = await Promise.all([
            import('https://cdn.jsdelivr.net/npm/topojson-client@3/+esm'),
            fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json').then(response => response.json())
          ]);
          // world.objects.land is a GeometryCollection, so topojson's
          // feature() returns a FeatureCollection (one Feature per land
          // mass) rather than a single Feature — reading `.geometry` off
          // the collection itself was always undefined, silently throwing
          // and falling back to the six-hull approximation below on every
          // load. Iterate the features instead.
          const landFeatures = feature(world, world.objects.land).features;
          const rings = [];
          landFeatures.forEach(({ geometry }) => {
            if (!geometry) return;
            const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
            polygons.forEach(polygon => polygon.forEach(ring => rings.push(ring)));
          });
          const maskWidth = 1440;
          const maskHeight = 720;
          const mask = new Uint8Array(maskWidth * maskHeight);
          for (let row = 0; row < maskHeight; row += 1) {
            const rowLatitude = 90 - ((row + .5) * 180) / maskHeight;
            const crossings = [];
            rings.forEach(ring => {
              for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [lonA, latA] = ring[i];
                const [lonB, latB] = ring[j];
                if ((latA > rowLatitude) !== (latB > rowLatitude)) {
                  crossings.push(lonA + ((rowLatitude - latA) * (lonB - lonA)) / (latB - latA));
                }
              }
            });
            crossings.sort((a, b) => a - b);
            for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
              const startColumn = Math.max(0, Math.ceil(((crossings[pair] + 180) * maskWidth) / 360 - .5));
              const endColumn = Math.min(maskWidth - 1, Math.floor(((crossings[pair + 1] + 180) * maskWidth) / 360 - .5));
              for (let column = startColumn; column <= endColumn; column += 1) {
                mask[row * maskWidth + column] = 1;
              }
            }
          }
          isLand = (latitude, longitude) => {
            const row = Math.min(maskHeight - 1, Math.max(0, Math.floor(((90 - latitude) * maskHeight) / 180)));
            const column = Math.min(maskWidth - 1, Math.max(0, Math.floor(((longitude + 180) * maskWidth) / 360)));
            return mask[row * maskWidth + column] === 1;
          };
        } catch (_) {
          // Offline or CDN unavailable — the stylized hulls still render.
        }

        const landDotPositions = [];
        const dotSamples = 70000;
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));
        for (let index = 0; index < dotSamples; index += 1) {
          const unitY = 1 - (index / (dotSamples - 1)) * 2;
          const latitude = THREE.MathUtils.radToDeg(Math.asin(unitY));
          const longitude = (((index * goldenAngle) % (Math.PI * 2)) / Math.PI) * 180 - 180;
          if (isLand(latitude, longitude)) {
            const dot = latLonToVector(latitude, longitude, globeRadius + .016);
            landDotPositions.push(dot.x, dot.y, dot.z);
          }
        }
        const landGeometry = new THREE.BufferGeometry();
        landGeometry.setAttribute('position', new THREE.Float32BufferAttribute(landDotPositions, 3));
        earth.add(new THREE.Points(
          landGeometry,
          new THREE.PointsMaterial({
            color: color('--fg'),
            size: .03,
            transparent: true,
            opacity: .72,
            depthWrite: false
          })
        ));

        // One line style per application status, so an arc's color tells you
        // where that connection actually stands: declined is red (matches
        // its red-X pulse — a faint grey line read as "nothing here" and
        // was too easy to miss entirely), interview is amber, accepted is
        // full accent green.
        const routeMaterials = {
          declined: new THREE.LineBasicMaterial({ color: color('--danger'), transparent: true, opacity: .5 }),
          interview: new THREE.LineBasicMaterial({ color: color('--warn'), transparent: true, opacity: .55 }),
          accepted: new THREE.LineBasicMaterial({ color: color('--accent'), transparent: true, opacity: .62 })
        };
        // Shown in the tooltip so a member can verify the pin against a real
        // map themselves — the globe itself is a stylized dot matrix with no
        // labels or borders, so the raw numbers are the only precise check.
        function formatCoordinate(latitude, longitude) {
          const lat = `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}`;
          const lon = `${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`;
          return `${lat}, ${lon}`;
        }

        const members = memberLocations.map(person => {
          const ownedProjects = projectsByOwner.get(person.id) || [];
          const projectSummary = ownedProjects.length
            ? ownedProjects.slice(0, 4).map(project => project.title).join(', ')
            : 'No open projects yet';
          const seatTotal = ownedProjects.reduce((sum, project) => sum + (Number(project.seats_total) || 0), 0);
          const coordinate = formatCoordinate(person.location_latitude, person.location_longitude);
          return {
            userId: String(person.id),
            name: person.display_name || 'connectEd member',
            headline: person.headline || '',
            summary: `${ownedProjects.length} open ${ownedProjects.length === 1 ? 'project' : 'projects'}${seatTotal ? ` · ${seatTotal} open ${seatTotal === 1 ? 'seat' : 'seats'}` : ''}`,
            projectSummary,
            coordinate,
            locationLabel: person.location_label || coordinate,
            latitude: person.location_latitude,
            longitude: person.location_longitude,
            viewer: Boolean(accountUser) && String(accountUser.id) === String(person.id),
            projectIds: ownedProjects.map(project => String(project.id))
          };
        });

        // Members within ~50km of each other share one node. An exact
        // coordinate match was too strict — two members a few km apart in
        // the same city landed as separate, nearly-touching dots whose hit
        // targets overlapped, so the smaller one couldn't reliably be
        // hovered or clicked. Grouping by real-world distance (haversine,
        // single-linkage) merges same-city members into one clickable node.
        const CLUSTER_RADIUS_KM = 50;
        function haversineKm(a, b) {
          const toRad = degrees => (degrees * Math.PI) / 180;
          const earthRadiusKm = 6371;
          const dLat = toRad(b.latitude - a.latitude);
          const dLon = toRad(b.longitude - a.longitude);
          const lat1 = toRad(a.latitude);
          const lat2 = toRad(b.latitude);
          const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
          return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
        }
        const clusterGroups = [];
        members.forEach(member => {
          const target = clusterGroups.find(group =>
            group.some(existing => haversineKm(existing, member) <= CLUSTER_RADIUS_KM)
          );
          if (target) target.push(member);
          else clusterGroups.push([member]);
        });
        const locations = clusterGroups.map(clusterMembers => {
          const primary = clusterMembers[0];
          const count = clusterMembers.length;
          const viewer = clusterMembers.some(member => member.viewer);
          const totalProjects = clusterMembers.reduce((sum, member) => sum + member.projectIds.length, 0);
          return {
            members: clusterMembers,
            userId: primary.userId,
            name: count > 1 ? `${count} members here` : primary.name,
            meta: count > 1
              ? `${primary.locationLabel} · ${count} members · ${totalProjects} open ${totalProjects === 1 ? 'project' : 'projects'}`
              : `${primary.locationLabel} · ${primary.summary}`,
            detail: count > 1
              ? `${clusterMembers.map(member => member.name).join(', ')} · ${primary.coordinate}`
              : `${primary.headline ? `${primary.headline}. ` : ''}${primary.projectSummary} · ${primary.coordinate}`,
            latitude: primary.latitude,
            longitude: primary.longitude,
            viewer,
            cluster: count > 1
          };
        });

        const viewerLocation = locations.find(location => location.viewer);
        const findMeButton = $('#network-step-find-me');
        if (findMeButton) findMeButton.hidden = !viewerLocation;

        // pulseRoutes only holds statuses worth animating — a pending
        // application isn't a live connection yet, so its arc is a static,
        // dim thread rather than something with a pulse traveling on it.
        const pulseRoutes = [];
        // The old control point — the midpoint of (start + end), normalized
        // — degenerates for anything far apart on the sphere: two nodes
        // ~150-180° apart make that sum nearly zero, so its normalized
        // direction becomes unstable and can point toward totally the
        // wrong side of the globe, sending the "arc" straight through it.
        // A proper spherical (SLERP) interpolation between the two surface
        // directions, bulged outward along the way, always stays above the
        // correct great-circle path no matter how far apart the endpoints
        // are — and the bulge height scales with the angular separation so
        // a near-antipodal arc rises well clear instead of skimming the
        // surface where it's most likely to clip.
        function buildArc(from, to, heightBoost = 0) {
          const startDir = latLonToVector(from.latitude, from.longitude, 1);
          const endDir = latLonToVector(to.latitude, to.longitude, 1);
          const dot = THREE.MathUtils.clamp(startDir.dot(endDir), -1, 1);
          const angle = Math.acos(dot);
          const sinAngle = Math.sin(angle);
          // Linear angle-to-height scaling (old: up to .95, ~39% of
          // globeRadius) made long-haul arcs balloon into towering loops
          // instead of clean domes. A sqrt curve rises fast for nearby
          // pairs, then flattens — every arc reads as a dome, not a loop.
          // heightBoost fans out extra arcs between the same two people
          // (multiple applications, or one in each direction) so they
          // don't sit on the exact same curve and z-fight.
          const height = Math.min(.4, .06 + Math.sqrt(angle / Math.PI) * .34) + heightBoost;
          function getPoint(t) {
            let dir;
            if (sinAngle < 1e-6) {
              // Same spot or exactly antipodal — SLERP direction is
              // undefined; a plain lerp is a safe, rare-case fallback.
              dir = startDir.clone().lerp(endDir, t).normalize();
            } else {
              const a = Math.sin((1 - t) * angle) / sinAngle;
              const b = Math.sin(t * angle) / sinAngle;
              dir = startDir.clone().multiplyScalar(a).add(endDir.clone().multiplyScalar(b));
            }
            const bulge = Math.sin(t * Math.PI) * height;
            return dir.multiplyScalar(globeRadius + .07 + bulge);
          }
          function getPoints(segments) {
            const points = [];
            for (let i = 0; i <= segments; i += 1) points.push(getPoint(i / segments));
            return points;
          }
          return { getPoint, getPoints };
        }
        function addRoute(from, to, status, heightBoost = 0, participantName = '', ownerName = '') {
          const curve = buildArc(from, to, heightBoost);
          earth.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(curve.getPoints(64)),
            routeMaterials[status]
          ));
          // Every status gets a traveling pulse now, including declined
          // (a red X) — nothing is drawn as a pulse-less dead thread
          // anymore. Carrying the two names lets a click on the pulse
          // itself explain the connection without having to go find and
          // click each endpoint node separately.
          pulseRoutes.push({ curve, status, participantName, ownerName });
        }
        // Real collaboration arcs, one per application: connecting two
        // member nodes rather than a member to a project (projects are no
        // longer nodes on this map). public_team_connections() is a
        // security-definer function that exposes only who's paired with
        // whom, and the status of each pairing — never a pending
        // application (that's a private "did I apply" signal) and never
        // the application message/answers — so this draws for every
        // visitor, signed in or not, instead of only the viewer's own
        // connections.
        if (isSupabaseConfigured) {
          try {
            // Any member maps to the node for their cluster, so an arc lands
            // on the shared pin when collaborators sit at the same spot.
            const nodeByUserId = new Map();
            locations.forEach(node => node.members.forEach(member => nodeByUserId.set(member.userId, node)));
            const { data: teamLinks, error: teamError } = await supabase.rpc('public_team_connections');
            if (!teamError) {
              // Every application between two people draws its own arc —
              // if they applied to each other, each direction gets its own
              // pulse traveling applicant-to-owner (naturally opposite
              // directions, since the two links swap which side is which).
              // A height offset per extra arc between the same two nodes
              // keeps them from sitting on the identical curve and
              // z-fighting when there's more than one.
              const arcCountByPair = new Map();
              (teamLinks || []).forEach(link => {
                const ownerId = String(link.owner_id);
                const applicantId = String(link.applicant_id);
                if (!ownerId || ownerId === applicantId) return;
                const ownerNode = nodeByUserId.get(ownerId);
                const participantNode = nodeByUserId.get(applicantId);
                if (!ownerNode || !participantNode) return;
                // Same cluster — a zero-length arc would render as an artifact.
                if (ownerNode === participantNode) return;
                const pairKey = [ownerId, applicantId].sort().join('|');
                const arcIndex = arcCountByPair.get(pairKey) || 0;
                arcCountByPair.set(pairKey, arcIndex + 1);
                const participantName = participantNode.members.find(member => member.userId === applicantId)?.name || participantNode.name;
                const ownerName = ownerNode.members.find(member => member.userId === ownerId)?.name || ownerNode.name;
                addRoute(participantNode, ownerNode, link.status, arcIndex * .07, participantName, ownerName);
              });
            }
          } catch (_) {
            // Query unavailable — the map still shows individual member pins.
          }
        }

        // Data packets travelling the routes — the "live network" signal.
        // Distinguished by shape, not just color, so the difference reads
        // even in a screenshot or to someone who can't tell amber from
        // green from red at a glance: accepted is a solid, filled dot (a
        // done deal), interview is a hollow ring (in progress, not yet
        // confirmed), declined is a red X (didn't work out).
        const ringCanvas = document.createElement('canvas');
        ringCanvas.width = 128;
        ringCanvas.height = 128;
        const ringCtx = ringCanvas.getContext('2d');
        ringCtx.strokeStyle = 'rgba(255,255,255,1)';
        ringCtx.lineWidth = 16;
        ringCtx.beginPath();
        ringCtx.arc(64, 64, 44, 0, Math.PI * 2);
        ringCtx.stroke();
        const ringTexture = new THREE.CanvasTexture(ringCanvas);
        const crossCanvas = document.createElement('canvas');
        crossCanvas.width = 128;
        crossCanvas.height = 128;
        const crossCtx = crossCanvas.getContext('2d');
        crossCtx.strokeStyle = 'rgba(255,255,255,1)';
        crossCtx.lineWidth = 16;
        crossCtx.lineCap = 'round';
        crossCtx.beginPath();
        crossCtx.moveTo(34, 34);
        crossCtx.lineTo(94, 94);
        crossCtx.moveTo(94, 34);
        crossCtx.lineTo(34, 94);
        crossCtx.stroke();
        const crossTexture = new THREE.CanvasTexture(crossCanvas);
        const acceptedCanvas = document.createElement('canvas');
        acceptedCanvas.width = 128;
        acceptedCanvas.height = 128;
        const acceptedCtx = acceptedCanvas.getContext('2d');
        const acceptedGradient = acceptedCtx.createRadialGradient(64, 64, 2, 64, 64, 58);
        acceptedGradient.addColorStop(0, 'rgba(255,255,255,1)');
        acceptedGradient.addColorStop(.16, 'rgba(255,255,255,.96)');
        acceptedGradient.addColorStop(.36, 'rgba(255,255,255,.48)');
        acceptedGradient.addColorStop(.7, 'rgba(255,255,255,.12)');
        acceptedGradient.addColorStop(1, 'rgba(255,255,255,0)');
        acceptedCtx.fillStyle = acceptedGradient;
        acceptedCtx.fillRect(0, 0, 128, 128);
        const acceptedTexture = new THREE.CanvasTexture(acceptedCanvas);
        const acceptedPulseMaterial = new THREE.SpriteMaterial({
          map: acceptedTexture,
          color: color('--accent'),
          transparent: true,
          opacity: .98,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        });
        const interviewPulseMaterial = new THREE.SpriteMaterial({
          map: ringTexture,
          color: color('--warn'),
          transparent: true,
          opacity: .95,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        });
        const declinedPulseMaterial = new THREE.SpriteMaterial({
          map: crossTexture,
          color: color('--danger'),
          transparent: true,
          opacity: .95,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        });
        const pulseShape = {
          accepted: { material: acceptedPulseMaterial, baseScale: .12 },
          interview: { material: interviewPulseMaterial, baseScale: .09 },
          // Slightly larger than the ring — an X drawn at the same size
          // reads smaller than a filled ring/dot because more of its
          // bounding square is empty, so it needs the extra size to carry
          // the same visual weight and not disappear against the globe.
          declined: { material: declinedPulseMaterial, baseScale: .12 }
        };
        const pulses = pulseRoutes.map(({ curve, status }, index) => {
          const shape = pulseShape[status];
          const pulse = shape
            ? new THREE.Sprite(shape.material)
            : new THREE.Sprite(acceptedPulseMaterial);
          pulse.userData = {
            curve,
            offset: pulseRoutes.length ? index / pulseRoutes.length : 0,
            baseScale: shape ? shape.baseScale : 1
          };
          earth.add(pulse);
          return pulse;
        });
        // The visible pulse shapes are small (and moving), which makes them
        // hard to actually land a click on — an invisible, generously sized
        // sphere trailing each one is what pointer/click hit-testing
        // actually targets, same "bigger invisible hit area than the
        // visible thing" pattern already used for the node markers
        // (markerGeometry vs markerHitGeometry below).
        const pulseHitGeometry = new THREE.SphereGeometry(.15, 8, 6);
        const pulseHitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
        const pulseHitTargets = pulseRoutes.map(({ status, participantName, ownerName }) => {
          const hitTarget = new THREE.Mesh(pulseHitGeometry, pulseHitMaterial);
          hitTarget.userData = { status, participantName, ownerName };
          earth.add(hitTarget);
          return hitTarget;
        });
        function updatePulses(time) {
          pulses.forEach((pulse, index) => {
            const progress = (time * .00005 + pulse.userData.offset) % 1;
            const position = pulse.userData.curve.getPoint(progress);
            pulse.position.copy(position);
            pulseHitTargets[index].position.copy(position);
            const pulseSize = pulse.userData.baseScale * (.5 + Math.sin(progress * Math.PI) * .9);
            pulse.scale.set(pulseSize, pulseSize, 1);
          });
        }

        const markerGeometry = new THREE.SphereGeometry(.028, 20, 16);
        const markerHitGeometry = new THREE.SphereGeometry(.11, 16, 12);
        // A soft radial-gradient sprite reads as a gentle glow; the flat
        // ring geometry this replaced had a hard, uniform edge that's a
        // dead giveaway for a generic "AI dashboard" globe.
        const glowCanvas = document.createElement('canvas');
        glowCanvas.width = 128;
        glowCanvas.height = 128;
        const glowCtx = glowCanvas.getContext('2d');
        const glowGradient = glowCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
        glowGradient.addColorStop(0, 'rgba(255,255,255,.85)');
        glowGradient.addColorStop(.45, 'rgba(255,255,255,.28)');
        glowGradient.addColorStop(1, 'rgba(255,255,255,0)');
        glowCtx.fillStyle = glowGradient;
        glowCtx.fillRect(0, 0, 128, 128);
        const glowTexture = new THREE.CanvasTexture(glowCanvas);
        // Radius scales with the square root of member count, so the node's
        // visual area (not its radius) is proportional to how many people
        // are there — the standard bubble-map convention, and a much more
        // legible read than a small linear bump per extra member.
        const baseScale = location => Math.min(3, Math.sqrt(location.cluster ? location.members.length : 1));
        // Node color scales from a muted neutral up to full accent green as
        // member count rises, instead of a flat "cluster vs. solo" binary —
        // so at a glance, greener/brighter dots mark the busier hubs rather
        // than every cluster (2 people or 20) looking identical.
        const MAX_COUNT_FOR_COLOR = 6;
        const countRatio = location => Math.min(1, ((location.cluster ? location.members.length : 1) - 1) / (MAX_COUNT_FOR_COLOR - 1));
        const neutralColor = new THREE.Color(color('--fg-2'));
        const accentColor = new THREE.Color(color('--accent'));
        const nodeColor = location => `#${neutralColor.clone().lerp(accentColor, countRatio(location)).getHexString()}`;
        const baseHaloOpacity = location => location.viewer ? .38 : .16 + countRatio(location) * .22;
        const markerTargets = [];
        const markers = locations.map(location => {
          const highlighted = location.viewer;
          const clusterScale = baseScale(location);
          const baseColorHex = nodeColor(location);
          const marker = new THREE.Group();
          const core = new THREE.Mesh(
            markerGeometry,
            new THREE.MeshStandardMaterial({
              color: highlighted ? color('--accent') : baseColorHex,
              emissive: highlighted ? color('--accent') : baseColorHex,
              emissiveIntensity: highlighted ? .72 : .28 + countRatio(location) * .35,
              roughness: .5
            })
          );
          const halo = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture,
            color: highlighted ? color('--accent') : baseColorHex,
            transparent: true,
            opacity: baseHaloOpacity(location),
            depthWrite: false,
            blending: THREE.AdditiveBlending
          }));
          halo.scale.set(.2, .2, 1);
          const hitTarget = new THREE.Mesh(
            markerHitGeometry,
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
          );
          hitTarget.userData = { location, marker, core, halo };
          markerTargets.push(hitTarget);
          marker.add(core, halo, hitTarget);
          marker.scale.setScalar(clusterScale);
          const position = latLonToVector(location.latitude, location.longitude, globeRadius + .085);
          marker.position.copy(position);
          marker.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 0, 1),
            position.clone().normalize()
          );
          marker.userData = location;
          earth.add(marker);
          return marker;
        });

        // Deep starfield behind the Earth: two layers of deterministic stars
        // scattered on a far shell for parallax depth.
        let starSeed = 7;
        const seededRandom = () => {
          starSeed = (starSeed * 16807) % 2147483647;
          return (starSeed - 1) / 2147483646;
        };
        [
          { count: 260, size: .022, opacity: .26, token: '--muted' },
          { count: 90, size: .05, opacity: .48, token: '--fg-2' }
        ].forEach(layer => {
          const starPositions = [];
          for (let index = 0; index < layer.count; index += 1) {
            const theta = seededRandom() * Math.PI * 2;
            const phi = Math.acos(seededRandom() * 2 - 1);
            const shellRadius = 8 + seededRandom() * 7;
            starPositions.push(
              shellRadius * Math.sin(phi) * Math.cos(theta) * 1.4,
              shellRadius * Math.sin(phi) * Math.sin(theta) * .8,
              -Math.abs(shellRadius * Math.cos(phi)) - 2.2
            );
          }
          const stars = new THREE.BufferGeometry();
          stars.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
          scene.add(new THREE.Points(
            stars,
            new THREE.PointsMaterial({
              color: color(layer.token),
              size: layer.size,
              transparent: true,
              opacity: layer.opacity,
              depthWrite: false
            })
          ));
        });

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2(4, 4);
        let visible = true;
        let userPaused = false;
        let frame = 0;
        let spin = -1.9;
        let pitch = .12;
        let dragging = false;
        let dragMoved = 0;
        let hoverPaused = false;
        let inertia = 0;
        let lastPointerX = 0;
        let lastPointerY = 0;
        let lastDragTime = 0;
        let previousTime = performance.now();
        // updatePulses used to take the raw wall-clock time directly, so
        // pausing froze the rotation (spin/pitch are correctly gated on
        // userPaused) but not the pulses — any manual render() call while
        // paused (hover, zoom, the end of a drag) still passed the current
        // real performance.now(), which made a paused pulse visibly jump
        // ahead to wherever it "should" be by now instead of staying put.
        // Accumulating a separate, pause-aware clock and only advancing it
        // when actually running fixes that.
        let pulseTime = 0;

        function updateGlobeFraming() {
          // Full-bleed framing: on wide viewports the Earth sits right of the
          // hero copy; on stacked layouts it re-centers and scales down.
          const stacked = window.matchMedia('(max-width: 900px)').matches;
          if (!stacked && camera.aspect > 1.15) {
            earth.position.set(
              Math.min(2.1, .28 * Math.tan(THREE.MathUtils.degToRad(19)) * camera.position.z * camera.aspect),
              0,
              0
            );
            earth.scale.setScalar(1);
          } else {
            earth.position.set(0, .08, 0);
            earth.scale.setScalar(stacked ? .72 : .85);
          }
        }

        function resize() {
          const width = Math.max(1, stage.clientWidth);
          const height = Math.max(1, stage.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          updateGlobeFraming();
          render(performance.now());
        }

        function render(time) {
          const elapsed = Math.min(48, Math.max(0, time - previousTime));
          previousTime = time;
          if (!reducedMotion && !userPaused && !dragging && !hoverPaused) {
            spin += elapsed * .00007;
          }
          if (!dragging && inertia) {
            spin += inertia * elapsed;
            inertia *= Math.pow(.9, elapsed / 16.7);
            if (Math.abs(inertia) < .000004) inertia = 0;
          }
          const ease = dragging ? .3 : .045;
          earth.rotation.y += (spin - earth.rotation.y) * ease;
          earth.rotation.x += (pitch - earth.rotation.x) * ease;
          // Pulses respect Pause motion / reduced-motion directly, same as
          // rotation — not drag/hover, which only freeze the camera spin
          // for interaction, not the underlying "live network" data motion.
          if (!reducedMotion && !userPaused) pulseTime += elapsed;
          updatePulses(pulseTime);
          renderer.render(scene, camera);
        }

        function animate(time) {
          if (!visible || reducedMotion || userPaused) return;
          render(time);
          frame = window.requestAnimationFrame(animate);
        }

        function startAnimation() {
          window.cancelAnimationFrame(frame);
          if (visible && !reducedMotion && !userPaused) {
            frame = window.requestAnimationFrame(animate);
          }
        }

        const connectionStatusLabel = {
          accepted: 'Accepted — confirmed team-up',
          interview: 'Interview in progress',
          declined: 'Declined — didn\'t work out'
        };
        function connectionTooltip({ participantName, ownerName, status }) {
          return `<small>${escapeHtml(connectionStatusLabel[status] || status)}</small>${escapeHtml(participantName)} → ${escapeHtml(ownerName)}<span>Applied to ${escapeHtml(ownerName)}'s project.</span>`;
        }
        function inspect(event) {
          const rect = canvas.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects([globeSurface, ...markerTargets, ...pulseHitTargets], false)[0];
          // Freeze the auto-spin while the pointer studies the planet so
          // markers hold still under the cursor.
          hoverPaused = Boolean(hit);
          markers.forEach(marker => {
            marker.scale.setScalar(baseScale(marker.userData));
            marker.children[1].material.opacity = baseHaloOpacity(marker.userData);
          });
          if (hit && markerTargets.includes(hit.object)) {
            const { location, marker, halo } = hit.object.userData;
            marker.scale.setScalar(baseScale(location) * 1.42);
            halo.material.opacity = .72;
            canvas.style.cursor = 'pointer';
            focus.innerHTML = `<small>${escapeHtml(location.meta)}</small>${escapeHtml(location.name)}<span>${escapeHtml(location.detail)}</span>`;
            // Ride beside the cursor, clamped inside the HUD bounds and
            // flipped to the opposite side near an edge.
            const hudRect = focus.parentElement.getBoundingClientRect();
            const cardWidth = focus.offsetWidth;
            const cardHeight = focus.offsetHeight;
            let tooltipX = event.clientX - hudRect.left + 18;
            let tooltipY = event.clientY - hudRect.top + 18;
            if (tooltipX + cardWidth > hudRect.width) tooltipX = event.clientX - hudRect.left - cardWidth - 18;
            if (tooltipY + cardHeight > hudRect.height) tooltipY = event.clientY - hudRect.top - cardHeight - 18;
            focus.style.setProperty('--tooltip-x', `${Math.max(0, tooltipX)}px`);
            focus.style.setProperty('--tooltip-y', `${Math.max(0, tooltipY)}px`);
            focus.classList.add('is-tooltip');
          } else if (hit && pulseHitTargets.includes(hit.object)) {
            // Same tooltip element/positioning as a node, so hovering a
            // pulse reads as the same kind of interaction — the point is
            // seeing what a connection is without hunting down both of its
            // endpoint nodes individually.
            canvas.style.cursor = 'pointer';
            focus.innerHTML = connectionTooltip(hit.object.userData);
            const hudRect = focus.parentElement.getBoundingClientRect();
            const cardWidth = focus.offsetWidth;
            const cardHeight = focus.offsetHeight;
            let tooltipX = event.clientX - hudRect.left + 18;
            let tooltipY = event.clientY - hudRect.top + 18;
            if (tooltipX + cardWidth > hudRect.width) tooltipX = event.clientX - hudRect.left - cardWidth - 18;
            if (tooltipY + cardHeight > hudRect.height) tooltipY = event.clientY - hudRect.top - cardHeight - 18;
            focus.style.setProperty('--tooltip-x', `${Math.max(0, tooltipX)}px`);
            focus.style.setProperty('--tooltip-y', `${Math.max(0, tooltipY)}px`);
            focus.classList.add('is-tooltip');
          } else {
            canvas.style.cursor = 'grab';
            focus.classList.remove('is-tooltip');
            focus.innerHTML = defaultFocusMarkup;
          }
          if (reducedMotion || userPaused || !visible) render(performance.now());
        }

        function beginDrag(event) {
          dragging = true;
          dragMoved = 0;
          inertia = 0;
          lastPointerX = event.clientX;
          lastPointerY = event.clientY;
          lastDragTime = performance.now();
          spin = earth.rotation.y;
          pitch = earth.rotation.x;
          try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
          canvas.style.cursor = 'grabbing';
          focus.classList.remove('is-tooltip');
          focus.innerHTML = defaultFocusMarkup;
        }
        // A touch/pen pointerdown doesn't commit to a rotate-drag right
        // away. On a phone the globe fills most of the screen, so an
        // ordinary scroll-down swipe usually starts right over it — the
        // board below looked like it didn't exist because there was no way
        // to reach it. touch-action: pan-y is supposed to hand vertical
        // gestures to native scrolling, but WebKit doesn't reliably honor
        // touch-action on a WebGL canvas, so this drives the scroll
        // manually once a gesture reads as vertical rather than trusting
        // that CSS alone. Mouse has no such ambiguity and drags immediately.
        let pendingTouch = null;
        let manualScroll = false;
        let suppressNextClick = false;
        const activeTouchPointers = new Map();
        let pinchStartDistance = 0;
        let pinchStartZoom = camera.position.z;
        const touchDistance = () => {
          const points = [...activeTouchPointers.values()];
          return points.length < 2 ? 0 : Math.hypot(
            points[0].clientX - points[1].clientX,
            points[0].clientY - points[1].clientY
          );
        };
        canvas.addEventListener('pointerdown', event => {
          if (event.pointerType === 'mouse') {
            if (event.button !== 0) return;
            stage.focus({ preventScroll: true });
            beginDrag(event);
            return;
          }
          activeTouchPointers.set(event.pointerId, {
            clientX: event.clientX,
            clientY: event.clientY
          });
          if (activeTouchPointers.size >= 2) {
            pinchStartDistance = touchDistance();
            pinchStartZoom = camera.position.z;
            pendingTouch = null;
            manualScroll = false;
            dragging = false;
            inertia = 0;
            return;
          }
          pendingTouch = event;
          manualScroll = false;
        });
        canvas.addEventListener('pointermove', event => {
          if (event.pointerType !== 'mouse' && activeTouchPointers.has(event.pointerId)) {
            activeTouchPointers.set(event.pointerId, {
              clientX: event.clientX,
              clientY: event.clientY
            });
          }
          if (activeTouchPointers.size >= 2) {
            event.preventDefault();
            const distance = touchDistance();
            if (pinchStartDistance > 0 && distance > 0) {
              camera.position.z = clampZoom(pinchStartZoom * (pinchStartDistance / distance));
              updateGlobeFraming();
              if (reducedMotion || userPaused || !visible) render(performance.now());
            }
            return;
          }
          if (pendingTouch && !dragging && !manualScroll) {
            const dx = event.clientX - pendingTouch.clientX;
            const dy = event.clientY - pendingTouch.clientY;
            // Wait for a clearer signal than a few px and bias the tie
            // toward scroll — a real thumb swiping "straight down" still
            // drifts sideways, and scroll is the safer default to fall
            // back on than eating the gesture into a globe spin.
            if (Math.hypot(dx, dy) < 12) return;
            if (Math.abs(dx) > Math.abs(dy) * 1.3) {
              beginDrag(pendingTouch);
            } else {
              manualScroll = true;
              lastPointerY = pendingTouch.clientY;
            }
          }
          if (manualScroll) {
            // Own the scroll outright — if pan-y also engages natively on
            // some platform, letting both act at once would double up and
            // feel jittery.
            event.preventDefault();
            window.scrollBy(0, lastPointerY - event.clientY);
            lastPointerY = event.clientY;
            return;
          }
          if (dragging) {
            const deltaX = event.clientX - lastPointerX;
            const deltaY = event.clientY - lastPointerY;
            lastPointerX = event.clientX;
            lastPointerY = event.clientY;
            dragMoved += Math.abs(deltaX) + Math.abs(deltaY);
            spin += deltaX * .0052;
            pitch = Math.max(-.7, Math.min(.85, pitch + deltaY * .0034));
            const now = performance.now();
            const elapsedDrag = Math.max(8, now - lastDragTime);
            lastDragTime = now;
            inertia = Math.max(-.008, Math.min(.008, (deltaX * .0052) / elapsedDrag));
            if (reducedMotion || userPaused || !visible) render(now);
            return;
          }
          inspect(event);
        });
        function endDrag(event) {
          activeTouchPointers.delete(event.pointerId);
          if (activeTouchPointers.size < 2) {
            pinchStartDistance = 0;
          }
          pendingTouch = null;
          manualScroll = false;
          if (!dragging) return;
          dragging = false;
          try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
          canvas.style.cursor = 'grab';
          suppressNextClick = dragMoved >= 6;
          if (dragMoved < 6 || reducedMotion) inertia = 0;
        }
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('lostpointercapture', endDrag);
        canvas.addEventListener('pointerleave', event => {
          if (dragging) endDrag(event);
          pendingTouch = null;
          manualScroll = false;
          activeTouchPointers.clear();
          pinchStartDistance = 0;
          pointer.set(4, 4);
          hoverPaused = false;
          canvas.style.cursor = 'grab';
          focus.classList.remove('is-tooltip');
          focus.innerHTML = defaultFocusMarkup;
          markers.forEach(marker => {
            marker.scale.setScalar(baseScale(marker.userData));
            marker.children[1].material.opacity = baseHaloOpacity(marker.userData);
          });
          if (reducedMotion || userPaused || !visible) render(performance.now());
        });
        canvas.addEventListener('click', event => {
          if (suppressNextClick) {
            suppressNextClick = false;
            dragMoved = 0;
            return;
          }
          dragMoved = 0;
          const rect = canvas.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects([...markerTargets, ...pulseHitTargets], false)[0];
          if (hit && pulseHitTargets.includes(hit.object)) {
            // Touch has no hover, so a tap needs its own confirmation
            // beyond the tooltip inspect() already shows on desktop hover —
            // this is the actual "click a pulse to see what's going on"
            // interaction on a phone.
            const { participantName, ownerName, status } = hit.object.userData;
            toast(`${participantName} → ${ownerName} · ${connectionStatusLabel[status] || status}`);
            return;
          }
          const location = hit?.object?.userData?.location;
          if (location) showMemberProjects(location);
        });
        // Chromium reports trackpad pinch as a ctrl/meta-modified wheel.
        // Keep ordinary two-finger scrolling available for moving down the page.
        const MIN_ZOOM = 3.2;
        const MAX_ZOOM = 10;
        const clampZoom = value => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
        const applyZoom = delta => {
          const nextZoom = clampZoom(camera.position.z + delta);
          if (Math.abs(nextZoom - camera.position.z) < .0001) return false;
          camera.position.z = nextZoom;
          updateGlobeFraming();
          if (reducedMotion || userPaused || !visible) render(performance.now());
          return true;
        };
        canvas.addEventListener('wheel', event => {
          const zoomEngaged = event.metaKey || event.ctrlKey;
          if (!zoomEngaged) return;
          const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? stage.clientHeight
              : 1;
          const normalizedDelta = Math.max(-120, Math.min(120, event.deltaY * modeScale));
          if (applyZoom(normalizedDelta * .007)) event.preventDefault();
        }, { passive: false });

        // Safari exposes trackpad pinch through gesture events rather than
        // wheel events. Keep this small compatibility path alongside wheel.
        let gestureStartZoom = camera.position.z;
        canvas.addEventListener('gesturestart', event => {
          gestureStartZoom = camera.position.z;
          event.preventDefault();
        }, { passive: false });
        canvas.addEventListener('gesturechange', event => {
          const scale = Math.max(.25, Math.min(4, Number(event.scale) || 1));
          camera.position.z = clampZoom(gestureStartZoom / scale);
          updateGlobeFraming();
          if (reducedMotion || userPaused || !visible) render(performance.now());
          event.preventDefault();
        }, { passive: false });

        const zoomInButton = $('#network-zoom-in');
        const zoomOutButton = $('#network-zoom-out');
        const zoomResetButton = $('#network-zoom-reset');
        if (zoomInButton) zoomInButton.onclick = () => applyZoom(-.55);
        if (zoomOutButton) zoomOutButton.onclick = () => applyZoom(.55);
        if (zoomResetButton) zoomResetButton.onclick = () => {
          camera.position.z = 6.65;
          updateGlobeFraming();
          if (reducedMotion || userPaused || !visible) render(performance.now());
        };

        stage.addEventListener('keydown', event => {
          const zoomStep = event.key === '+' || event.key === '='
            ? -.45
            : event.key === '-'
              ? .45
              : 0;
          if (zoomStep && applyZoom(zoomStep)) {
            event.preventDefault();
          } else if (event.key === '0') {
            camera.position.z = 6.65;
            updateGlobeFraming();
            if (reducedMotion || userPaused || !visible) render(performance.now());
            event.preventDefault();
          }
        });

        const interactiveStageLabel = stage.getAttribute('aria-label');
        canvas.addEventListener('webglcontextlost', event => {
          event.preventDefault();
          stage.classList.remove('webgl-ready');
          stage.setAttribute('aria-label', 'The interactive globe is temporarily unavailable.');
          window.cancelAnimationFrame(frame);
        });
        canvas.addEventListener('webglcontextrestored', () => {
          stage.setAttribute('aria-label', interactiveStageLabel);
          stage.classList.add('webgl-ready');
          resize();
          startAnimation();
        });

        const observer = new ResizeObserver(resize);
        observer.observe(stage);
        const visibilityObserver = new IntersectionObserver(entries => {
          visible = entries[0]?.isIntersecting ?? true;
          startAnimation();
        }, { threshold: .05 });
        visibilityObserver.observe(stage);

        resize();
        stage.classList.add('webgl-ready');
        if (findMeButton && viewerLocation) {
          findMeButton.onclick = () => {
            // Rotating earth.rotation.y by -longitude brings a point at that
            // longitude to face the fixed camera (derived from the standard
            // Y-axis rotation matrix: it's the angle that zeroes out the
            // point's rotated X component while keeping Z positive, i.e.
            // pointed at the camera rather than the antipodal side).
            // rotation.x by +latitude does the same for vertical centering.
            spin = -THREE.MathUtils.degToRad(viewerLocation.longitude);
            pitch = THREE.MathUtils.clamp(THREE.MathUtils.degToRad(viewerLocation.latitude), -.7, .85);
            inertia = 0;
            hoverPaused = false;
            // The animation loop eases toward spin/pitch a few percent per
            // frame — great for a drag release, but with motion paused (or
            // reduced-motion) there's no loop running any of those frames,
            // so it would barely nudge instead of visibly moving. Snap
            // straight there in that case instead.
            if (userPaused || reducedMotion) {
              earth.rotation.y = spin;
              earth.rotation.x = pitch;
              render(performance.now());
            }
            startAnimation();
          };
        }
        if (motionToggle && !reducedMotion) {
          motionToggle.hidden = false;
          motionToggle.onclick = () => {
            userPaused = !userPaused;
            motionToggle.setAttribute('aria-pressed', String(userPaused));
            motionToggle.textContent = userPaused ? 'Resume motion' : 'Pause motion';
            if (userPaused) render(performance.now());
            startAnimation();
          };
        }
        startAnimation();
      } catch (error) {
        stage.classList.remove('webgl-ready');
        console.warn('Connected Earth fallback active.', error);
      }
    }

    // One-time "pin yourself" invite for signed-in members without a
    // shared location. Consent stays with the browser permission prompt;
    // coordinates are rounded to ~1 km before they are saved anywhere.
    function initLocationInvite() {
      const invite = $('#location-invite');
      const stageButton = $('#network-step-location');
      if (!isSupabaseConfigured) {
        if (invite) invite.hidden = true;
        if (stageButton) stageButton.hidden = true;
        return;
      }

      const alreadyShared = Boolean(accountUser && profileLocation(accountProfile));

      // Visible even signed out — clicking it while signed out opens sign-in
      // first; once that completes, onAuthStateChange re-runs this function
      // and the button is ready to actually share.
      if (stageButton) {
        stageButton.hidden = false;
        stageButton.textContent = alreadyShared ? 'Update location' : 'Share location';
        stageButton.onclick = accountUser
          ? () => openModal('location')
          : () => openModal('auth');
      }

      if (!accountUser) {
        if (invite) invite.hidden = true;
        return;
      }
      if (!invite) return;
      if (alreadyShared) { invite.hidden = true; return; }
      const dismissKey = `connected:location-invite:${accountUser.id}`;
      try { if (localStorage.getItem(dismissKey) === 'dismissed') return; } catch (_) {}
      invite.hidden = false;
      $('#location-invite-dismiss').onclick = () => {
        invite.hidden = true;
        try { localStorage.setItem(dismissKey, 'dismissed'); } catch (_) {}
      };
      $('#location-invite-share').onclick = () => openModal('location');
    }

    async function saveMemberLocation({ label = null, latitude, longitude }) {
      try {
        const profileResult = await supabase.from('profiles')
          .update({ location_label: label, location_latitude: latitude, location_longitude: longitude })
          .eq('id', accountUser.id);
        if (profileResult.error) throw profileResult.error;
        toast('Pinned. Reloading the Earth…');
        window.setTimeout(() => window.location.reload(), 900);
        return true;
      } catch (error) {
        toast(error.message || 'Location could not be saved.');
        return false;
      }
    }

    // Typing a city needs no GPS permission — geocode it through a free,
    // keyless lookup so pinning yourself works either way, matching the
    // same option already offered in the profile tab.
    async function geocodeLabel(label) {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(label)}`,
          { headers: { Accept: 'application/json' } }
        );
        if (!response.ok) return null;
        const results = await response.json();
        const match = results[0];
        if (!match) return null;
        return { latitude: Number(Number(match.lat).toFixed(2)), longitude: Number(Number(match.lon).toFixed(2)) };
      } catch (_) {
        return null;
      }
    }

    $('#location-use-gps').onclick = event => {
      if (!accountUser) return toast('Sign in to pin your location.');
      if (!navigator.geolocation) return toast('Location is not supported by this browser.');
      const button = event.currentTarget;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(async position => {
        const latitude = Number(position.coords.latitude.toFixed(2));
        const longitude = Number(position.coords.longitude.toFixed(2));
        const saved = await saveMemberLocation({ latitude, longitude });
        if (!saved) {
          button.disabled = false;
          button.textContent = original;
        }
      }, error => {
        toast(error.code === 1 ? 'Location permission was not granted.' : 'Your location could not be determined.');
        button.disabled = false;
        button.textContent = original;
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    };

    $('#location-form').onsubmit = async event => {
      event.preventDefault();
      if (!accountUser) return toast('Sign in to pin your location.');
      const label = String(event.currentTarget.city.value || '').trim();
      if (!label) return toast('Type a city, or use "Use my current location".');
      const submitButton = event.currentTarget.querySelector('[type="submit"]');
      const original = submitButton.textContent;
      submitButton.disabled = true;
      submitButton.textContent = 'Looking up…';
      const geocoded = await geocodeLabel(label);
      if (!geocoded) {
        toast('Could not find that location — try being more specific.');
        submitButton.disabled = false;
        submitButton.textContent = original;
        return;
      }
      const saved = await saveMemberLocation({ label, latitude: geocoded.latitude, longitude: geocoded.longitude });
      if (!saved) {
        submitButton.disabled = false;
        submitButton.textContent = original;
      }
    };

    if (supabase) {
      supabase.auth.onAuthStateChange(() => refreshAccount());
    }
    $('#auth-preview-note').hidden = !isEmbeddedPreview();
    await Promise.all([refreshAccount(), loadProjects()]);
    initProjectNetwork();
