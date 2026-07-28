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
    const safeTags = value => String(value || '')
      .split(',')
      .map(tag => tag.trim().toLowerCase().replace(/[^a-z0-9 +#.-]/g, ''))
      .filter(Boolean)
      .slice(0, 8);
    const PROJECT_IMAGE_PREFIX = '__image__:';
    const PROJECT_LOCATION_PREFIX = '__location__:';
    const APPLICATIONS_PAUSED_TAG = '__applications_paused__';
    const projectTags = project => (project?.tags || [])
      .filter(tag =>
        !String(tag).startsWith(PROJECT_IMAGE_PREFIX) &&
        !String(tag).startsWith(PROJECT_LOCATION_PREFIX) &&
        String(tag) !== APPLICATIONS_PAUSED_TAG
      );
    const projectImageData = project => {
      const marker = (project?.tags || []).find(tag => String(tag).startsWith(PROJECT_IMAGE_PREFIX));
      return marker ? String(marker).slice(PROJECT_IMAGE_PREFIX.length) : '';
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
        const target = modal.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
        (target || modal).focus();
      });
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
      const focusable = [...activeModal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hidden && element.offsetParent !== null);
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

      const { data, error } = await supabase
        .from('projects')
        .select('id,title,summary,description,tags,status,seats_total,boost_until,owner_id,profiles:owner_id(display_name)')
        .neq('status', 'closed')
        .order('boost_until', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (error) {
        projects = [];
        board.innerHTML = '<div class="empty">Projects could not be loaded. <button class="btn btn-small" id="retry-projects" type="button">Retry</button></div>';
        $('#retry-projects').onclick = loadProjects;
        board.setAttribute('aria-busy', 'false');
        toast('Projects could not be loaded.');
        return;
      } else {
        projects = (data || []).map(project => ({
          ...project,
          owner: project.profiles?.display_name || 'connectEd member'
        }));
      }
      renderProjectFilters();
      renderProjects();
      board.setAttribute('aria-busy', 'false');
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

      $('#project-pins').innerHTML = filtered.length
        ? filtered.map((project, index) => {
            const boosted = project.boost_until && new Date(project.boost_until) > new Date();
            const statusClass = boosted ? 'is-boosted' : project.status === 'invite_only' ? 'is-invite' : 'is-open';
            const statusLabel = boosted ? 'Boosted idea' : project.status === 'invite_only' ? 'Invite only' : 'Open project';
            const seatCount = Number(project.seats_total) || 0;
            const seatSuffix = seatCount ? ` · ${seatCount} ${seatCount === 1 ? 'seat' : 'seats'}` : '';
            return `
              <article class="pin glass" data-od-id="project-card-${escapeHtml(project.id)}">
                <div class="pin-cover">
                  <img src="${projectImageData(project) || projectCover(project)}" alt="" loading="lazy" decoding="async"
                    onerror="this.onerror=null;this.src='${projectCover(project)}'">
                  <span class="pin-status ${statusClass}">${statusLabel}</span>
                </div>
                <div class="pin-body">
                  <h3 class="pin-title">${escapeHtml(project.title)}</h3>
                  <p>${escapeHtml(project.summary)}</p>
                  <div class="tags">
                    ${projectTags(project).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
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
        .slice(0, 8);
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
      $('#project-title').textContent = activeProject.title;
      const detailSeats = Number(activeProject.seats_total) || 0;
      $('#project-owner').textContent = `Shared by ${activeProject.owner}${detailSeats ? ` · ${detailSeats} ${detailSeats === 1 ? 'seat' : 'seats'}` : ''}`;
      $('#project-description').textContent = activeProject.description;
      $('#project-tags').innerHTML = projectTags(activeProject)
        .map(tag => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join('');

      let questions = [];
      if (isSupabaseConfigured && !id.startsWith('preview-')) {
        const result = await supabase
          .from('project_questions')
          .select('id,prompt,required,position')
          .eq('project_id', id)
          .order('position');
        if (!result.error) questions = result.data || [];
      }
      activeProject.questions = questions;
      $('#project-questions').innerHTML = questions.map(question => `
        <label>
          ${escapeHtml(question.prompt)}
          <textarea class="field" name="question-${escapeHtml(question.id)}"
            maxlength="2000" ${question.required ? 'required' : ''}></textarea>
        </label>
      `).join('');
      openModal('project');
    }

    // Clicking a node opens the published projects of everyone pinned there
    // — a member can own several projects, and a node can represent several
    // members sharing one spot, so this can't just jump into one apply form.
    function showMemberProjects(node) {
      const projectCard = project => {
        const seatCount = Number(project.seats_total) || 0;
        return `
          <article class="member-project-item">
            <h3>${escapeHtml(project.title)}</h3>
            <p>${escapeHtml(project.summary)}</p>
            <div class="tags">${projectTags(project).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
            <div class="member-project-foot">
              <span class="owner">${seatCount ? `${seatCount} ${seatCount === 1 ? 'seat' : 'seats'}` : ''}</span>
              <button class="btn btn-primary btn-small" data-apply-project="${escapeHtml(project.id)}">Apply</button>
            </div>
          </article>
        `;
      };
      const members = node.members.map(member => ({
        member,
        projects: member.projectIds.map(id => projects.find(project => String(project.id) === id)).filter(Boolean)
      }));
      if (!members.some(entry => entry.projects.length)) {
        return toast(node.cluster
          ? "None of the members at this spot have published a project yet."
          : `${node.name} hasn't published a project yet.`);
      }
      $('#member-projects-name').textContent = node.cluster ? node.meta.split(' · ')[0] : node.name;
      $('#member-projects-list').innerHTML = members.map(({ member, projects: memberProjects }) => {
        if (!memberProjects.length) return '';
        const heading = node.cluster ? `<h4 class="member-project-group">${escapeHtml(member.name)}</h4>` : '';
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

      const question = String(values.get('question')).trim();
      const questionResult = await supabase.from('project_questions').insert({
        project_id: data.id,
        prompt: question,
        position: 0,
        required: true
      });
      if (questionResult.error) return toast(questionResult.error.message);

      form.reset();
      resetProjectImagePreview();
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
        closeModal('project');
        openModal('auth');
        toast('Sign in before applying.');
        return;
      }
      if (!activeProject || String(activeProject.id).startsWith('preview-')) {
        return toast('Preview projects do not accept applications.');
      }
      if (activeProject.owner_id === user.id) return toast('You already own this project.');

      const values = new FormData(form);
      const answers = {};
      for (const question of activeProject.questions || []) {
        answers[question.id] = String(values.get(`question-${question.id}`) || '').trim();
      }
      const { error } = await supabase.from('applications').insert({
        project_id: activeProject.id,
        applicant_id: user.id,
        message: String(values.get('message')).trim(),
        answers
      });
      if (error) return toast(error.code === '23505' ? 'You already applied to this project.' : error.message);
      form.reset();
      closeModal('project');
      toast('Application sent to the project owner.');
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
        const data = await response.json();
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
          toast(error.message || 'Something went wrong. Please try again.');
        } finally {
          form.setAttribute('aria-busy', 'false');
          if (submit) {
            submit.disabled = false;
            submit.textContent = originalLabel;
          }
        }
      };
    }
    bindAsyncForm('#create-form', createProject, 'Publishing…');
    bindAsyncForm('#join-form', submitApplication, 'Sending…');
    $('#plus-checkout').onclick = startCheckout;
    const projectSearchInputs = [$('#nav-search'), $('#mobile-project-search')];
    projectSearchInputs.forEach(input => {
      input.oninput = () => {
        projectSearchInputs.forEach(peer => {
          if (peer !== input) peer.value = input.value;
        });
        renderProjects();
      };
    });

    $$('[data-open]:not(#account-button)').forEach(button => {
      if (button.dataset.open) button.addEventListener('click', () => openModal(button.dataset.open));
    });
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
        ? `Live member network<span>Drag to explore, ⌘/Ctrl + scroll to zoom. Hover a node to see ${memberLocations.length} ${memberLocations.length === 1 ? 'member' : 'members'} and the projects they're building.</span>`
        : 'Live member network<span>Drag to explore, ⌘/Ctrl + scroll to zoom. Share your location from your profile to place the first node.</span>';
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

        const participantRouteMaterial = new THREE.LineBasicMaterial({
          color: color('--accent'),
          transparent: true,
          opacity: .58
        });
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

        const routeCurves = [];
        function addRoute(from, to) {
          const start = latLonToVector(from.latitude, from.longitude, globeRadius + .07);
          const end = latLonToVector(to.latitude, to.longitude, globeRadius + .07);
          const midpoint = start.clone().add(end).normalize().multiplyScalar(globeRadius + .62);
          const curve = new THREE.QuadraticBezierCurve3(start, midpoint, end);
          routeCurves.push(curve);
          earth.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(curve.getPoints(64)),
            participantRouteMaterial
          ));
        }
        // Real collaboration arcs: accepted participants ↔ the owner of the
        // project they joined, connecting two member nodes rather than a
        // member to a project (projects are no longer nodes on this map).
        // Row-level security scopes the query — signed-out visitors keep the
        // ambient member pins without arcs.
        if (accountUser && isSupabaseConfigured) {
          try {
            const ownerByProjectId = new Map(projects.map(project => [String(project.id), String(project.owner_id)]));
            // Any member maps to the node for their cluster, so an arc lands
            // on the shared pin when collaborators sit at the same spot.
            const nodeByUserId = new Map();
            locations.forEach(node => node.members.forEach(member => nodeByUserId.set(member.userId, node)));
            const { data: teamLinks, error: teamError } = await supabase
              .from('applications')
              .select('project_id,applicant_id,status')
              .eq('status', 'accepted');
            if (!teamError) {
              const drawnPairs = new Set();
              (teamLinks || []).forEach(link => {
                const ownerId = ownerByProjectId.get(String(link.project_id));
                const applicantId = String(link.applicant_id);
                if (!ownerId || ownerId === applicantId) return;
                const ownerNode = nodeByUserId.get(ownerId);
                const participantNode = nodeByUserId.get(applicantId);
                if (!ownerNode || !participantNode) return;
                // Same cluster — a zero-length arc would render as an artifact.
                if (ownerNode === participantNode) return;
                const pairKey = [ownerId, applicantId].sort().join('|');
                if (drawnPairs.has(pairKey)) return;
                drawnPairs.add(pairKey);
                addRoute(participantNode, ownerNode);
              });
            }
          } catch (_) {
            // Query unavailable — the map still shows individual member pins.
          }
        }

        // Data packets travelling the routes — the "live network" signal.
        const pulseMaterial = new THREE.MeshBasicMaterial({
          color: color('--accent'),
          transparent: true,
          opacity: .9,
          depthWrite: false
        });
        const pulseGeometry = new THREE.SphereGeometry(.035, 12, 10);
        const pulses = routeCurves.map((curve, index) => {
          const pulse = new THREE.Mesh(pulseGeometry, pulseMaterial);
          pulse.userData = { curve, offset: routeCurves.length ? index / routeCurves.length : 0 };
          earth.add(pulse);
          return pulse;
        });
        function updatePulses(time) {
          pulses.forEach(pulse => {
            const progress = (time * .00005 + pulse.userData.offset) % 1;
            pulse.position.copy(pulse.userData.curve.getPoint(progress));
            pulse.scale.setScalar(.5 + Math.sin(progress * Math.PI) * .9);
          });
        }

        const markerGeometry = new THREE.SphereGeometry(.028, 20, 16);
        const markerHitGeometry = new THREE.SphereGeometry(.11, 16, 12);
        const haloGeometry = new THREE.RingGeometry(.044, .07, 32);
        // Radius scales with the square root of member count, so the node's
        // visual area (not its radius) is proportional to how many people
        // are there — the standard bubble-map convention, and a much more
        // legible read than a small linear bump per extra member.
        const baseScale = location => Math.min(3, Math.sqrt(location.cluster ? location.members.length : 1));
        const baseHaloOpacity = location => location.viewer ? .38 : location.cluster ? .3 : .18;
        const markerTargets = [];
        const markers = locations.map(location => {
          const highlighted = location.viewer;
          const clusterScale = baseScale(location);
          const marker = new THREE.Group();
          const core = new THREE.Mesh(
            markerGeometry,
            new THREE.MeshStandardMaterial({
              color: color(highlighted ? '--accent' : location.cluster ? '--accent' : '--fg'),
              emissive: color(highlighted ? '--accent' : location.cluster ? '--accent' : '--fg-2'),
              emissiveIntensity: highlighted ? .72 : location.cluster ? .5 : .28,
              roughness: .5
            })
          );
          const halo = new THREE.Mesh(
            haloGeometry,
            new THREE.MeshBasicMaterial({
              color: color(highlighted ? '--accent' : location.cluster ? '--accent' : '--fg-2'),
              transparent: true,
              opacity: baseHaloOpacity(location),
              side: THREE.DoubleSide,
              depthWrite: false
            })
          );
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

        function resize() {
          const width = Math.max(1, stage.clientWidth);
          const height = Math.max(1, stage.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
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
          updatePulses(time);
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

        function inspect(event) {
          const rect = canvas.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects([globeSurface, ...markerTargets], false)[0];
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
          } else {
            canvas.style.cursor = 'grab';
            focus.classList.remove('is-tooltip');
            focus.innerHTML = defaultFocusMarkup;
          }
          if (reducedMotion || userPaused || !visible) render(performance.now());
        }

        canvas.addEventListener('pointerdown', event => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
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
        });
        canvas.addEventListener('pointermove', event => {
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
          if (!dragging) return;
          dragging = false;
          try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
          canvas.style.cursor = 'grab';
          if (dragMoved < 6 || reducedMotion) inertia = 0;
        }
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('pointerleave', () => {
          if (dragging) return;
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
          if (dragMoved >= 6) return;
          const rect = canvas.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(markerTargets, false)[0];
          const location = hit?.object?.userData?.location;
          if (location) showMemberProjects(location);
        });
        // Zoom is opt-in behind Cmd/Ctrl so an ordinary two-finger scroll
        // over the globe still scrolls the page instead of trapping the
        // cursor — only the modified gesture takes over the camera.
        const MIN_ZOOM = 3.2;
        const MAX_ZOOM = 10;
        canvas.addEventListener('wheel', event => {
          if (!event.metaKey && !event.ctrlKey) return;
          event.preventDefault();
          camera.position.z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.position.z + event.deltaY * .01));
          if (reducedMotion || userPaused || !visible) render(performance.now());
        }, { passive: false });

        canvas.addEventListener('webglcontextlost', event => {
          event.preventDefault();
          stage.classList.remove('webgl-ready');
          window.cancelAnimationFrame(frame);
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
          ? event => shareLocationInline(event.currentTarget, stageButton.textContent)
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
      $('#location-invite-share').onclick = event => shareLocationInline(event.currentTarget);
    }

    function shareLocationInline(button, originalLabel = 'Share location') {
      if (!navigator.geolocation) return toast('Location is not supported by this browser.');
      button.disabled = true;
      button.textContent = 'Locating…';
      const restore = () => {
        button.disabled = false;
        button.textContent = originalLabel;
      };
      navigator.geolocation.getCurrentPosition(async position => {
        const latitude = Number(position.coords.latitude.toFixed(2));
        const longitude = Number(position.coords.longitude.toFixed(2));
        try {
          const profileResult = await supabase.from('profiles')
            .update({ location_label: null, location_latitude: latitude, location_longitude: longitude })
            .eq('id', accountUser.id);
          if (profileResult.error) throw profileResult.error;
          toast('Pinned. Reloading the Earth…');
          window.setTimeout(() => window.location.reload(), 900);
        } catch (error) {
          toast(error.message || 'Location could not be saved.');
          restore();
        }
      }, error => {
        toast(error.code === 1 ? 'Location permission was not granted.' : 'Your location could not be determined.');
        restore();
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    }

    if (supabase) {
      supabase.auth.onAuthStateChange(() => refreshAccount());
    }
    $('#auth-preview-note').hidden = !isEmbeddedPreview();
    await Promise.all([refreshAccount(), loadProjects()]);
    initProjectNetwork();
