import { NEWS_LABELS } from '../core/News.js';

/**
 * Affiche une liste d'événements ({ when, text, kind[, source] }) dans un <ol class="log">.
 * Avec `withSource`, chaque ligne porte l'étiquette de son module (fil d'actualité).
 */
export function renderLog(list, events, { withSource = false, empty = 'Rien à signaler… pour l\'instant.' } = {}) {
  list.replaceChildren();
  if (events.length === 0) {
    const li = document.createElement('li');
    li.className = 'log__empty';
    li.textContent = empty;
    list.appendChild(li);
    return;
  }
  for (const event of events) {
    const li = document.createElement('li');
    li.dataset.kind = event.kind;
    const time = document.createElement('time');
    time.textContent = event.when;
    const text = document.createElement('span');
    if (withSource && event.source) {
      li.dataset.source = event.source;
      const tag = document.createElement('b');
      tag.className = 'log__tag';
      tag.textContent = NEWS_LABELS[event.source];
      text.append(tag, ' ');
    }
    text.append(event.text);
    li.append(time, text);
    list.appendChild(li);
  }
}
