import { RouterProvider, createHashRouter } from 'react-router-dom';
import { IconSprite } from './components/icons/IconSprite';
import { routes } from './routes';
import { RoughFilters } from './theme/RoughFilters';

// Hash, not browser routing: no backend means no server to configure an SPA fallback on, and hash
// URLs work from a static host, from file:// and from `vite preview` with zero config (§6.1).
const router = createHashRouter(routes);

// ponytail: <ToastHost/> (§3.1) lands with the screen that first needs to raise a toast.
export default function App() {
  return (
    <>
      {/* Both are mounted once for the whole app: every url(#cb-rough-*) and <use href="#gi-*"> in
          the tree resolves against them. */}
      <RoughFilters />
      <IconSprite />
      <RouterProvider router={router} />
    </>
  );
}
