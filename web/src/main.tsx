import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom'
// The /react entry point, not /next: this is a Vite SPA, and the Next.js build of this
// package imports next/navigation, which does not resolve here. Route changes are picked
// up from the History API, so one mount at the root covers every page.
import { Analytics } from '@vercel/analytics/react'
import App from './App'
import DashboardPage from './pages/DashboardPage'
import NotebookPage from './pages/NotebookPage'
import NotePage from './features/editor/NotePage'
import StudyPage from './features/study/StudyPage'
import AskPage from './features/ask/AskPage'
import CapturePage from './features/import/CapturePage'
import SearchPage from './pages/SearchPage'
import TagsPage from './pages/TagsPage'
import { AuthProvider, useAuth } from './features/auth/AuthContext'
import RequireAuth from './features/auth/RequireAuth'
import LandingPage from './features/marketing/LandingPage'
import LoginPage from './features/auth/LoginPage'
import SignupPage from './features/auth/SignupPage'
import RecoverPage from './features/auth/RecoverPage'
import JoinPage from './features/share/JoinPage'
import './styles/index.css'

// AuthProvider sits inside the router (rather than around RouterProvider) so the auth
// pages can use useNavigate/useLocation, and so one /me call serves every route.
function AuthRoot() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}

// "/" serves two different products depending on who is asking: the marketing page to a
// visitor, the dashboard to a signed-in user.
//
// The pathname check matters. Only the index is public - a signed-out visitor deep-linking
// to /study or /note/x must still fall through to RequireAuth, which sends them to /login
// and remembers where they were headed. Without it they would land on the marketing page
// with their destination silently discarded.
//
// No loading branch is needed: AuthProvider withholds render entirely until the first /me
// settles, so `user` is already decided by the time this runs.
function RootRoute() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  if (!user && pathname === '/') return <LandingPage />
  return (
    <RequireAuth>
      <App />
    </RequireAuth>
  )
}

const router = createBrowserRouter([
  {
    element: <AuthRoot />,
    children: [
      // Public, and deliberately outside <App> - a signed-out visitor must not see
      // the sidebar or trigger the shell's authenticated data fetches.
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/recover', element: <RecoverPage /> },

      // Share links. PUBLIC and outside RequireAuth by design - a guest opening
      // one has no Unote account at all; their access is a per-share cookie the
      // join call sets. It stays inside AuthRoot so the page can still recognise
      // the note's OWNER when they open their own link.
      { path: '/join/:token', element: <JoinPage /> },

      // Phone capture flow renders without the desktop shell, but still needs a session:
      // it writes notes into the signed-in user's notebooks.
      { path: '/capture', element: <RequireAuth><CapturePage /></RequireAuth> },
      {
        path: '/',
        element: <RootRoute />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'notebook/:notebookId', element: <NotebookPage /> },
          { path: 'note/:noteId', element: <NotePage /> },
          { path: 'study', element: <StudyPage /> },
          { path: 'ask', element: <AskPage /> },
          { path: 'search', element: <SearchPage /> },
          { path: 'tags', element: <TagsPage /> },
        ],
      },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Analytics />
  </StrictMode>,
)
