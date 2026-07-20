import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom'
import App from './App'
import DashboardPage from './pages/DashboardPage'
import NotebookPage from './pages/NotebookPage'
import NotePage from './features/editor/NotePage'
import StudyPage from './features/study/StudyPage'
import AskPage from './features/ask/AskPage'
import CapturePage from './features/import/CapturePage'
import SearchPage from './pages/SearchPage'
import TagsPage from './pages/TagsPage'
import { AuthProvider } from './features/auth/AuthContext'
import RequireAuth from './features/auth/RequireAuth'
import LoginPage from './features/auth/LoginPage'
import SignupPage from './features/auth/SignupPage'
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

const router = createBrowserRouter([
  {
    element: <AuthRoot />,
    children: [
      // Public, and deliberately outside <App> — a signed-out visitor must not see
      // the sidebar or trigger the shell's authenticated data fetches.
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },

      // Phone capture flow renders without the desktop shell, but still needs a session:
      // it writes notes into the signed-in user's notebooks.
      { path: '/capture', element: <RequireAuth><CapturePage /></RequireAuth> },
      {
        path: '/',
        element: (
          <RequireAuth>
            <App />
          </RequireAuth>
        ),
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
  </StrictMode>,
)
