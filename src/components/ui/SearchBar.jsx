import { useEffect, useRef, useState } from 'react';
import { useKnowledgeStore } from '../../store/knowledgeStore.js';
import { useMotionSensor } from '../../utils/motionSensor.js';

/**
 * Terminal-style search input, centred at the top — the only 2D element.
 *  - 260ms after typing stops → search. Until the query equals the top
 *    match's full title, results only preview off-centre.
 *  - Enter → confirm: the top match goes to the centre regardless.
 *  - ESC (handled in App) → reset.
 * On phones it also holds the tilt-steering (IMU) toggle.
 */
export function SearchBar() {
  const query = useKnowledgeStore((s) => s.query);
  const { setQuery, search, resetView } = useKnowledgeStore.getState();
  const sensor = useMotionSensor();
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current.focus();
    return () => clearTimeout(debounceRef.current);
  }, []);

  const handleChange = (e) => {
    const value = e.target.value;
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value), 260);
  };

  const handleKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(debounceRef.current);
    search(e.currentTarget.value, { confirmed: true });
  };

  return (
    <div className={`search-bar ${focused ? 'is-focused' : ''}`}>
      <span className="search-bar__prompt">{'>'}</span>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="SEARCH KNOWLEDGE_"
        aria-label="Search programming knowledge"
        className="search-bar__input"
        spellCheck={false}
        autoComplete="off"
      />
      {query && (
        <button
          type="button"
          onClick={() => {
            clearTimeout(debounceRef.current);
            resetView();
          }}
          className="search-bar__btn"
          aria-label="Clear search"
        >
          [X]
        </button>
      )}
      {sensor.available && (
        <button
          type="button"
          className={`search-bar__btn ${sensor.active ? 'is-on' : ''}`}
          onClick={sensor.active ? sensor.deactivate : sensor.activate}
          aria-label={sensor.active ? 'Disable motion sensor' : 'Enable motion sensor'}
        >
          {sensor.active ? '[IMU:ON]' : '[IMU]'}
        </button>
      )}
      {sensor.error && <p className="search-bar__error">! {sensor.error}</p>}
    </div>
  );
}
